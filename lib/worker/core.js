'use strict';

/* jshint worker:true */

var Promise = require('pouchdb-promise');
var errors = require('../shared/errors');
var workerUtils = require('./utils');
var decodeArgs = workerUtils.decodeArgs;
var dbs = {};
var allChanges = {};

var log = require('debug')('pouchdb:worker');

function registerWorkerPouch(self, pouchCreator) {

  function sendUncaughtError(clientId, data) {
    log(' -> sendUncaughtError', clientId, data);
    self.postMessage({
      type: 'uncaughtError',
      id: clientId,
      content: workerUtils.createError(data)
    });
  }

  function sendError(clientId, messageId, data) {
    log(' -> sendError', clientId, messageId, data);
    self.postMessage({
      type: 'error',
      id: clientId,
      messageId: messageId,
      content: workerUtils.createError(data)
    });
  }

  function sendSuccess(clientId, messageId, data) {
    log(' -> sendSuccess', clientId, messageId);
    self.postMessage({
      type: 'success',
      id: clientId,
      messageId: messageId,
      content: data
    });
  }

  function sendUpdate(clientId, messageId, data) {
    log(' -> sendUpdate', clientId, messageId);
    self.postMessage({
      type: 'update',
      id: clientId,
      messageId: messageId,
      content: data
    });
  }

  function dbMethod(clientId, methodName, messageId, args) {
    var db = dbs['$' + clientId];
    if (!db) {
      return sendError(clientId, messageId, {error: 'db not found'});
    }
    Promise.resolve().then(function () {
      return db[methodName].apply(db, args);
    }).then(function (res) {
      sendSuccess(clientId, messageId, res);
    }).catch(function (err) {
      sendError(clientId, messageId, err);
    });
  }

  function changes(clientId, messageId, args) {
    var opts = args[0];
    if (opts && typeof opts === 'object') {
      // just send all the docs anyway because we need to emit change events
      // TODO: be smarter about emitting changes without building up an array
      opts.returnDocs = true;
      opts.return_docs = true;
    }
    dbMethod(clientId, 'changes', messageId, args);
  }

  function getAttachment(clientId, messageId, args) {
    var db = dbs['$' + clientId];
    if (!db) {
      return sendError(clientId, messageId, {error: 'db not found'});
    }

    Promise.resolve().then(function () {
      var docId = args[0];
      var attId = args[1];
      var opts = args[2];
      if (typeof opts !== 'object') {
        opts = {};
      }
      return db.get(docId, opts).then(function (doc) {
        if (!doc._attachments || !doc._attachments[attId]) {
          throw errors.MISSING_DOC;
        }
        return db.getAttachment.apply(db, args).then(function (buff) {
          sendSuccess(clientId, messageId, buff);
        });
      });
    }).catch(function (err) {
      sendError(clientId, messageId, err);
    });
  }

  function destroy(clientId, messageId, args) {
    var key = '$' + clientId;
    var db = dbs[key];
    if (!db) {
      return sendError(clientId, messageId, {error: 'db not found'});
    }
    delete dbs[key];
    Promise.resolve().then(function () {
      return db.destroy.apply(db, args);
    }).then(function (res) {
      sendSuccess(clientId, messageId, res);
    }).catch(function (err) {
      sendError(clientId, messageId, err);
    });
  }

  function liveChanges(clientId, messageId, args) {
    var db = dbs['$' + clientId];
    if (!db) {
      return sendError(clientId, messageId, {error: 'db not found'});
    }
    Promise.resolve().then(function () {
      var changes = db.changes(args[0]);
      allChanges[messageId] = changes;
      changes.on('change', function (change) {
        sendUpdate(clientId, messageId, change);
      }).on('complete', function (change) {
        changes.removeAllListeners();
        delete allChanges[messageId];
        sendSuccess(clientId, messageId, change);
      }).on('error', function (change) {
        changes.removeAllListeners();
        delete allChanges[messageId];
        sendError(clientId, messageId, change);
      });
    });
  }

  function cancelChanges(messageId) {
    var changes = allChanges[messageId];
    if (changes) {
      changes.cancel();
    }
  }

  function addUncaughtErrorHandler(db, clientId) {
    return Promise.resolve().then(function () {
      db.on('error', function (err) {
        sendUncaughtError(clientId, err);
      });
    });
  }

  function createDatabase(clientId, messageId, args) {
    var key = '$' + clientId;
    var db = dbs[key];
    if (db) {
      return addUncaughtErrorHandler(db, clientId).then(function () {
        return sendSuccess(clientId, messageId, {ok: true, exists: true});
      });
    }

    var name = typeof args[0] === 'string' ? args[0] : args[0].name;

    if (!name) {
      return sendError(clientId, messageId, {
        error: 'you must provide a database name'
      });
    }

    db = dbs[key] = pouchCreator(args[0]);
    addUncaughtErrorHandler(db, clientId).then(function () {
      sendSuccess(clientId, messageId, {ok: true});
    }).catch(function (err) {
      sendError(clientId, messageId, err);
    });
  }

  function onReceiveMessage(clientId, type, messageId, args) {
    log('onReceiveMessage', type, clientId, messageId, args);
    switch (type) {
      case 'createDatabase':
        return createDatabase(clientId, messageId, args);
      case 'id':
        sendSuccess(clientId, messageId, clientId);
        return;
      case 'info':
      case 'put':
      case 'allDocs':
      case 'bulkDocs':
      case 'post':
      case 'get':
      case 'remove':
      case 'revsDiff':
      case 'compact':
      case 'viewCleanup':
      case 'removeAttachment':
      case 'putAttachment':
      case 'query':
        return dbMethod(clientId, type, messageId, args);
      case 'changes':
        return changes(clientId, messageId, args);
      case 'getAttachment':
        return getAttachment(clientId, messageId, args);
      case 'liveChanges':
        return liveChanges(clientId, messageId, args);
      case 'cancelChanges':
        return cancelChanges(messageId);
      case 'destroy':
        return destroy(clientId, messageId, args);
      default:
        return sendError(clientId, messageId, {error: 'unknown API method: ' + type});
    }
  }

  function handleMessage(message, clientId) {
    var type = message.type;
    var messageId = message.messageId;
    var args = decodeArgs(message.args);
    onReceiveMessage(clientId, type, messageId, args);
  }

  self.addEventListener('message', function (event) {
    if (!event.data || !event.data.id || !event.data.args ||
        !event.data.type || !event.data.messageId) {
      // assume this is not a message from worker-pouch
      // (e.g. the user is using the custom API instead)
      return;
    }
    var clientId = event.data.id;
    if (event.data.type === 'close') {
      log('closing worker', clientId);
      delete dbs['$' + clientId];
    } else {
      handleMessage(event.data, clientId);
    }
  });
}

module.exports = registerWorkerPouch;
