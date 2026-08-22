import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/fnos-browser-config'

export const fnosBrowserConfigRoutes = new Router()

fnosBrowserConfigRoutes.get('/api/hermes/browser/config', ctrl.state)
fnosBrowserConfigRoutes.post('/api/hermes/browser/config/profiles', ctrl.create)
fnosBrowserConfigRoutes.patch('/api/hermes/browser/config/profiles/:profileId', ctrl.update)
fnosBrowserConfigRoutes.post('/api/hermes/browser/config/active', ctrl.activate)
fnosBrowserConfigRoutes.delete('/api/hermes/browser/config/profiles/:profileId', ctrl.remove)
