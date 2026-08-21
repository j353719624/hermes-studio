import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/fnos-browser'

export const fnosBrowserRoutes = new Router()

fnosBrowserRoutes.get('/api/hermes/browser/state', ctrl.state)
fnosBrowserRoutes.post('/api/hermes/browser/navigate', ctrl.navigate)
fnosBrowserRoutes.post('/api/hermes/browser/action', ctrl.action)
fnosBrowserRoutes.post('/api/hermes/browser/close', ctrl.close)
