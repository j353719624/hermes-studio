import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/fnos-system'

export const fnosSystemRoutes = new Router()

fnosSystemRoutes.get('/api/hermes/fnos/system-info', ctrl.info)
