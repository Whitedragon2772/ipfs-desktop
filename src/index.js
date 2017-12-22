import menubar from 'menubar'
import fs from 'fs'
import ipfsd from 'ipfsd-ctl'
import {join} from 'path'
import {dialog, ipcMain, app} from 'electron'

import config from './config'
import registerControls from './controls/main'
import handleKnownErrors from './errors'
import StatsPoller from './utils/stats-poller'

const {logger} = config

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit()
}

// Ensure it's a single instance
app.makeSingleInstance(() => {
  logger.error('Trying to start a second instance')
  dialog.showErrorBox(
    'Multiple instances',
    'Sorry, but there can be only one instance of Station running at the same time.'
  )
})

// Local Variables

let poller = null
let IPFS
let mb

function send (type, arg) {
  if (mb && mb.window && mb.window.webContents) {
    mb.window.webContents.send(type, arg)
  }
}

function stopPolling () {
  if (poller) poller.stop()
}

function startPolling () {
  if (poller) poller.start()
}

function onPollerChange (stats) {
  send('stats', stats)
}

function onRequestState (node, event) {
  if (node.initialized) {
    let status = 'stopped'

    if (node.daemonPid()) {
      status = IPFS ? 'running' : 'starting'
    }

    send('node-status', status)
  }
}

function onStartDaemon (node) {
  logger.info('Start daemon')
  send('node-status', 'starting')

  node.startDaemon((err, ipfsNode) => {
    if (err) {
      handleKnownErrors(err)
      return
    }

    poller = new StatsPoller(ipfsNode, logger)

    if (mb.window && mb.window.isVisible()) {
      poller.start()
    }

    poller.on('change', onPollerChange)
    mb.on('show', startPolling)
    mb.on('hide', stopPolling)

    mb.tray.setImage(config.logo.ice)

    send('node-status', 'running')
    IPFS = ipfsNode
  })
}

function onStopDaemon (node, done) {
  logger.info('Stopping daemon')
  send('node-status', 'stopping')

  if (poller) {
    poller.stop()
    poller = null
  }

  if (mb) {
    mb.removeListener('show', startPolling)
    mb.removeListener('hide', stopPolling)
  }

  node.stopDaemon((err) => {
    if (err) { return logger.error(err.stack) }

    logger.info('Stopped daemon')
    mb.tray.setImage(config.logo.black)

    IPFS = null
    send('node-status', 'stopped')
    done()
  })
}

function onWillQuit (node, event) {
  logger.info('Shutting down application')

  if (IPFS == null) {
    return
  }

  event.preventDefault()
  onStopDaemon(node, () => { app.quit() })
}

// Initalize a new IPFS node
function initialize (path, node) {
  logger.info('Initialzing new node')

  mb.window.loadURL(`file://${__dirname}/views/welcome.html`)
  mb.window.webContents.on('did-finish-load', () => {
    send('setup-config-path', path)
  })
  mb.showWindow()

  // Close the application if the welcome dialog is canceled
  mb.window.once('close', () => {
    if (!node.initialized) app.quit()
  })

  let userPath = path

  ipcMain.on('setup-browse-path', () => {
    dialog.showOpenDialog(mb.window, {
      title: 'Select a directory',
      defaultPath: path,
      properties: [
        'openDirectory',
        'createDirectory'
      ]
    }, (res) => {
      if (!res) return

      userPath = res[0]

      if (!userPath.match(/.ipfs\/?$/)) {
        userPath = join(userPath, '.ipfs')
      }

      send('setup-config-path', userPath)
    })
  })

  // wait for msg from frontend
  ipcMain.on('initialize', (event, { keySize }) => {
    logger.info(`Initializing new node with key size: ${keySize} in ${userPath}.`)

    send('initializing')
    node.init({
      directory: userPath,
      keySize: keySize
    }, (err, res) => {
      if (err) {
        return send('initialization-error', String(err))
      }

      fs.writeFileSync(config.ipfsPathFile, path)

      send('initialization-complete')
      send('node-status', 'stopped')

      onStartDaemon(node)
      mb.window.loadURL(config.menubar.index)
    })
  })
}

// main entry point
ipfsd.local((err, node) => {
  if (err) {
    // We can't start if we fail to aquire
    // a ipfs node
    logger.error(err)
    process.exit(1)
  }

  mb = menubar(config.menubar)

  mb.on('ready', () => {
    logger.info('Application is ready')
    mb.tray.setHighlightMode(true)

    ipcMain.on('request-state', onRequestState.bind(null, node))
    ipcMain.on('start-daemon', onStartDaemon.bind(null, node))
    ipcMain.on('stop-daemon', onStopDaemon.bind(null, node, () => {}))
    app.once('will-quit', onWillQuit.bind(null, node))

    registerControls({
      ipfs: () => {
        return IPFS
      },
      send: send,
      menubar: mb,
      logger: config.logger,
      fileHistory: config.fileHistory,
      ipfsPath: config.ipfsPath
    })

    if (!node.initialized) {
      initialize(config.ipfsPath, node)
    } else {
      // Start up the daemon
      onStartDaemon(node)
    }
  })
})