import Router from '@koa/router'
import * as ctrl from '../../controllers/hermes/fnos-runtime'
import { requireSuperAdmin } from '../../middleware/user-auth'

export const fnosRuntimeRoutes = new Router()

fnosRuntimeRoutes.get('/api/hermes/fnos-runtime', requireSuperAdmin, ctrl.status)
fnosRuntimeRoutes.post('/api/hermes/fnos-runtime/upgrade', requireSuperAdmin, ctrl.upgrade)
