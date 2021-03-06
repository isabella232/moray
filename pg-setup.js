/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var assert = require('assert-plus');
var exeunt = require('exeunt');
var libuuid = require('libuuid');
var mod_artedi = require('artedi');
var mod_cmd = require('./lib/cmd');
var mod_forkexec = require('forkexec');
var mod_fs = require('fs');
var mod_getopt = require('posix-getopt');
var mod_jsprim = require('jsprim');
var mod_manatee = require('node-manatee');
var mod_pg = require('./lib/pg');
var mod_schema = require('./lib/schema');
var vasync = require('vasync');
var VError = require('verror');

// --- Globals

var FLAVOR = 'sdc';
var DBNAME = process.env.MORAY_DB_NAME || 'moray';
var MORAY_USER = 'moray';
var RESERVE_CONNS = 18;
var SMF_EXIT_NODAEMON = 94;
var SUCCESSFUL_SETUP_SENTINEL = '/var/tmp/.moray-pg-setup-done';

var CREATE_BUCKETS_CFG_SQL = 'CREATE TABLE IF NOT EXISTS buckets_config (' +
    'name text PRIMARY KEY, ' +
    'index text NOT NULL, ' +
    'pre text NOT NULL, ' +
    'post text NOT NULL, ' +
    'options text, ' +
    'mtime timestamp without time zone DEFAULT now() NOT NULL' +
');';

var ALTER_BUCKETS_CFG_SQL =
    'ALTER TABLE buckets_config OWNER TO ' + MORAY_USER + ';';


var NAME = 'pg-setup';
var LOG = mod_cmd.setupLogger(NAME);


// --- Helpers

function query(opts, sql, args, callback) {
    opts.db.pg(function (cErr, pg) {
        if (cErr) {
            callback(new VError(cErr,
                'failed to acquire client for (sql=%j)', sql));
            return;
        }

        var reqid = libuuid.create();
        pg.setRequestId(reqid);

        var req = pg.query(sql, args);
        var results = [];

        LOG.info({
            req_id: reqid,
            sql: sql,
            args: args
        }, 'running postgres query');

        req.on('error', function (qErr) {
            pg.release();

            callback(qErr);
        });

        req.on('row', function (r) {
            results.push(r);
        });

        req.on('end', function (_) {
            pg.release();

            callback(null, results);
        });
    });
}

// --- Postgres Setup

/**
 * Repeat a simple query until we get a result back, to confirm that the
 * database is now ready.
 */
function waitUntilReady(opts, callback) {
    var args = [
        'psql',
        '-U', 'postgres',
        '-d', 'postgres',
        '-h', opts.primary.address,
        '-p', opts.primary.port.toString(),
        '-c', 'SELECT now() AS when;'
    ];

    LOG.info({ cmd: 'psql', argv: args }, 'Executing command');

    mod_forkexec.forkExecWait({ argv: args },
        function (err, info) {
        if (err) {
            LOG.warn(info, 'database not yet ready');
            setImmediate(waitUntilReady, opts, callback);
            return;
        }

        LOG.info({ info: info }, 'database is now ready');

        callback();
    });
}

/**
 * We create a non-superuser account for Moray to use, not just to help with
 * locking down its capabilities but also so that the reserved connections are
 * actually useful. The user will be able to create new tables, but not new
 * roles.
 *
 * If the user already exists, then the command will fail. The Postgres CLI
 * tools don't do a great job at communicating the reason for failure in their
 * return codes, so, to keep this script idempotent, we ignore the failure and
 * just error out later on when running SQL that expects the user to exist.
 */
function createUser(opts, callback) {
    var args = [
        'createuser',
        '-U', 'postgres',
        '-h', opts.primary.address,
        '-p', opts.primary.port.toString(),
        '-d', '-S', '-R',
        MORAY_USER
    ];

    LOG.info({ cmd: 'createuser', argv: args }, 'Executing command');

    mod_forkexec.forkExecWait({ argv: args },
        function (err, info) {
        if (err) {
            LOG.warn(info,
                'failed to create %j user; ' +
                'continuing under the assumption that it already exists',
                MORAY_USER);
        } else {
            LOG.info('created new %s user', MORAY_USER);
        }

        /*
         * We may have already created the user, so we don't propagate the
         * error.
         */
        callback();
    });
}


/**
 * Having 18 reserve connections ensures that the maximum possible number of
 * Moray postgres connections does not exceed the imposed "moray"
 * rolconnlimit in any of the default deployment sizes: coal, lab,
 * production.
 *
 *       pg_max_conns  procs_per_zone      num_zones  max_conns_per_proc
 * coal  100           1                   1          16
 * lab   210           4                   3          16
 * prod  1000          4                   3          16
 *
 * pg_max_conns - the default value of the postgres parameter
 * max_connections set in postgres.conf for each deployment size.
 *
 * procs_per_zone - the default number of processes per Moray zone for the
 * given deployment size.
 *
 * num_zones - the default number of Moray zones per shard for the
 * deployment size.
 *
 * max_conns_per_proc - the default value of the SAPI tunable
 * MORAY_MAX_PG_CONNS.
 *
 * Reserving 18 connections imposes an upper bound of 82, 192, and 982 moray
 * role connections in coal, lab, and production deployments. These upper
 * bounds are fine because with their default configurations, coal, lab, and
 * production deployment Morays may have (in aggregate) a maximum of 16,
 * 192, and 192 total connections to postgres, respectively.
 */
function setConnLimit(opts, callback) {
    if (FLAVOR !== 'manta') {
        callback();
        return;
    }

    query(opts, 'SHOW max_connections;', [], function (sErr, results) {
        if (sErr) {
            LOG.warn(sErr, 'Unable to retrieve postgres max_connections; ' +
                'role property \'rolconnlimit\' not applied to \'moray\'');
            callback();
            return;
        }

        if (results.length < 1) {
            LOG.warn('no "max_connections" results returned; ' +
                'role property \'rolconnlimit\' not applied to \'moray\'');
            callback();
            return;
        }

        var maxconns = results[0].max_connections;
        if (maxconns <= RESERVE_CONNS) {
            LOG.warn({
                max_connections: maxconns,
                reserve_connections: RESERVE_CONNS
            }, 'Maximum allowed Postgres connections is lower than the ' +
               'number of reserve connections; ' +
               'role property \'rolconnlimit\' not applied to \'moray\'');
            callback();
            return;
        }


        var limit = maxconns - RESERVE_CONNS;
        var sql = 'ALTER ROLE ' +
            MORAY_USER + ' WITH CONNECTION LIMIT ' + limit;

        query(opts, sql, [], function (aErr) {
            if (aErr) {
                callback(new VError(aErr, 'failed to set connection limit'));
                return;
            }

            LOG.info('Successfully set %s user connection limit to %d',
                MORAY_USER, limit);

            callback();
        });
    });
}

/**
 * Setup the database for Moray to use. Since we can't conditionally create the
 * database like we can tables, we ignore any errors here, since it likely
 * already exists.
 */
function createDB(opts, callback) {
    var args = [
        'createdb',
        '-U', 'postgres',
        '-T', 'template0',
        '--locale=C',
        '-E', 'UNICODE',
        '-O', MORAY_USER,
        '-h', opts.primary.address,
        '-p', opts.primary.port.toString(),
        DBNAME
    ];

    LOG.info({ cmd: 'createdb', argv: args }, 'Executing command');

    mod_forkexec.forkExecWait({ argv: args }, function (err, info) {
        if (err) {
            LOG.warn(info, 'failed to create %j database', DBNAME);
        } else {
            LOG.info(info, 'created new %j database', DBNAME);
        }

        /*
         * We may have already created the database, so we don't propagate the
         * error.
         */
        callback();
    });
}

function createTable(opts, callback) {
    query(opts, CREATE_BUCKETS_CFG_SQL, [], callback);
}

function changeTableOwner(opts, callback) {
    query(opts, ALTER_BUCKETS_CFG_SQL, [], callback);
}

/**
 * While this script is designed to be idempotent, there's really no need for
 * us to always try it. Once we've done everything, we write out a file so that
 * we won't retry on future reboots. (Reprovisions will wipe the file though,
 * and we'll run again then.)
 */
function writeSentinel(_, callback) {
    mod_fs.writeFile(SUCCESSFUL_SETUP_SENTINEL, '', callback);
}

function setupPostgres(opts, callback) {
    if (mod_fs.existsSync(SUCCESSFUL_SETUP_SENTINEL)) {
        LOG.info('Found %j, skipping setup', SUCCESSFUL_SETUP_SENTINEL);
        setImmediate(callback);
        return;
    }

    vasync.pipeline({
        arg: opts,
        funcs: [
            waitUntilReady,
            createUser,
            setConnLimit,
            createDB,
            createTable,
            changeTableOwner,
            writeSentinel
        ]
    }, callback);
}

function parseOptions() {
    var parser = new mod_getopt.BasicParser(':vf:r:', process.argv);
    var option;
    var opts = {};

    while ((option = parser.getopt()) !== undefined) {
        switch (option.option) {
        case 'f':
            opts.file = option.optarg;
            break;

        case 'v':
            LOG = mod_cmd.increaseVerbosity(LOG);
            break;

        case 'r':
            FLAVOR = option.optarg;
            break;

        case ':':
            throw new VError('Expected argument for -%s', option.optopt);

        default:
            throw new VError('Invalid option: -%s', option.optopt);
        }
    }

    if (parser.optind() !== process.argv.length) {
        throw new VError(
            'Positional arguments found when none were expected: %s',
            process.argv.slice(parser.optind()).join(' '));
    }

    if (!opts.file) {
        LOG.fatal({ opts: opts }, 'No config file specified.');
        throw new Error('No config file specified');
    }

    return (opts);
}

function main() {
    var options = parseOptions();
    var config = mod_cmd.readConfig(options);

    config.log = LOG;
    mod_schema.validateConfig(config);
    assert.object(config.manatee, 'config.manatee');

    var dbopts = config.manatee;
    dbopts.manatee.log = LOG;

    var dbresolver = mod_manatee.createPrimaryResolver(dbopts.manatee);

    LOG.info('Fetching Manatee state');

    /*
     * We wait indefinitely until the Manatee cluster is ready and we have a
     * primary that we can connect to. If there are multiple Moray instances,
     * they'll all start trying to initialize the database at once. Since all
     * of the operations here are okay to rerun, this should be okay.
     *
     * If the primary changes underneath us then the CLI tools will fail, and
     * we'll exit this script. SMF will then take care of restarting us, and
     * we'll try again with the new primary. (If this happens enough times,
     * then we'll go into maintenance, and an operator will have to intervene.)
     */
    dbresolver.once('added', function (_, primary) {
        var collector = mod_artedi.createCollector({ labels: {} });
        var db = mod_pg.createPool(mod_jsprim.mergeObjects(dbopts.pg, {
            log: LOG,
            domain: 'manatee',
            user: 'postgres',
            collector: collector,
            resolver: dbresolver
        }));

        setupPostgres({
            resolver: dbresolver,
            primary: primary,
            config: config,
            db: db
        }, function (err) {
            db.close();

            if (err) {
                LOG.error(err, 'failed to set up postgres');
                exeunt(1);
            } else {
                LOG.info('successfully set up postgres');
                exeunt(SMF_EXIT_NODAEMON);
            }
        });
    });

    dbresolver.start();
}

main();
