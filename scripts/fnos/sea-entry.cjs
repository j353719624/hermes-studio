'use strict'

const { createRequire } = require('node:module')
const { dirname, join } = require('node:path')

const appRoot = dirname(process.execPath)
process.chdir(appRoot)

const requireFromApp = createRequire(join(appRoot, 'package.json'))
requireFromApp(join(appRoot, 'dist', 'server', 'index.js'))
