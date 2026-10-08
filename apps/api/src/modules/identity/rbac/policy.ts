import { ForbiddenError } from '../../../errors/app-error.js';

export type Role = 'ADMINISTRATOR' | 'MERCHANT' | 'CUSTOMER';

export type Permission =
  | 'identity:read-self'
  | 'identity:change-password'
  | 'merchant:onboard'
  | 'merchant:read-own'
  | 'merchant:update-own'
  | 'merchant:submit-for-verification'
  | 'merchant:verify' // admin only
  | 'merchant:reject' // admin only
  | 'admin:manage-users'
  | 'admin:view-audit'
  | 'catalog:read'
  | 'catalog:create'
  | 'catalog:update'
  | 'catalog:status'
  | 'listing:create'
  | 'listing:read-own'
  | 'listing:update-own'
  | 'listing:status-own'
  | 'listing:read-any'
  | 'listing:manage-any'
  | 'inventory:create'
  | 'inventory:read-own'
  | 'inventory:read-any'
  | 'inventory:adjust-own'
  | 'inventory:reserve'
  | 'inventory:release-own'
  | 'inventory:consume-own'
  | 'inventory:manage-any'
  | 'cart:read-own'
  | 'cart:write-own'
  | 'checkout:create-own'
  | 'checkout:read-own'
  | 'checkout:read-any'
  | 'checkout:manage-any'
  | 'order:create-own'
  | 'order:read-own'
  | 'order:read-seller-own'
  | 'order:read-any'
  | 'order:manage-any'
  | 'payment:create-own'
  | 'payment:read-own'
  | 'payment:manage-any'
  | 'fulfillment:create-own'
  | 'fulfillment:read-own'
  | 'fulfillment:update-own'
  | 'fulfillment:manage-any'
  | 'return:create-own'
  | 'return:read-own'
  | 'return:manage-own'
  | 'return:cancel-own'
  | 'return:manage-any'
  | 'settlement:read-own'
  | 'settlement:manage-any'
  | 'search:reindex'
  | 'search:manage'
  | 'events:read'
  | 'events:manage'
  | 'notifications:read'
  | 'notifications:manage'
  | 'analytics:read-own'
  | 'analytics:read-any'
  | 'analytics:rebuild'
  | 'recommendations:read'
  | 'recommendations:rebuild'
  | 'ml:read-own'
  | 'ml:read-any'
  | 'ml:train'
  | 'ml:manage'
  | 'ai:chat'
  | 'ai:documents:manage'
  | 'ai:documents:read'
  | 'ai:diagnostics:read'
  | 'promotion:create-own'
  | 'promotion:read-own'
  | 'promotion:update-own'
  | 'promotion:read-any'
  | 'promotion:manage-any'
  | 'promotion:validate'
  | 'customer:address:read-own'
  | 'customer:address:manage-own'
  | 'customer:address:read-any'
  | 'customer:address:manage-any'
  | 'review:create-own'
  | 'review:read-own'
  | 'review:update-own'
  | 'review:delete-own'
  | 'review:read-any'
  | 'review:moderate-own'
  | 'review:moderate-any'
  | 'wishlist:read-own'
  | 'wishlist:write-own'
  | 'back-in-stock:read-own'
  | 'back-in-stock:write-own';

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  CUSTOMER: [
    'identity:read-self',
    'identity:change-password',
    'catalog:read',
    'recommendations:read',
    'listing:read-any',
    'inventory:reserve',
    'inventory:release-own',
    'cart:read-own',
    'cart:write-own',
    'checkout:create-own',
    'checkout:read-own',
    'order:create-own',
    'order:read-own',
    'payment:create-own',
    'payment:read-own',
    'fulfillment:read-own',
    'return:create-own',
    'return:read-own',
    'return:cancel-own',
    'ai:chat',
    'promotion:validate',
    'promotion:read-any',
    'customer:address:read-own',
    'customer:address:manage-own',
    'review:create-own',
    'review:read-own',
    'review:update-own',
    'review:delete-own',
    'review:read-any',
    'wishlist:read-own',
    'wishlist:write-own',
    'back-in-stock:read-own',
    'back-in-stock:write-own',
  ],
  MERCHANT: [
    'identity:read-self',
    'identity:change-password',
    'merchant:onboard',
    'merchant:read-own',
    'merchant:update-own',
    'merchant:submit-for-verification',
    'catalog:read',
    'catalog:status',
    'listing:create',

    'listing:read-own',
    'listing:update-own',
    'listing:status-own',
    'listing:read-any',
    'inventory:create',
    'inventory:read-own',
    'inventory:adjust-own',
    'inventory:reserve',
    'inventory:release-own',
    'inventory:consume-own',
    'order:read-seller-own',
    'fulfillment:create-own',
    'fulfillment:read-own',
    'fulfillment:update-own',
    'return:read-own',
    'return:manage-own',
    'settlement:read-own',
    'analytics:read-own',
    'recommendations:read',
    'ml:read-own',
    'ml:train',
    'ml:manage',
    'ai:chat',
    'ai:documents:manage',
    'ai:documents:read',
    'promotion:create-own',
    'promotion:read-own',
    'promotion:update-own',
    'promotion:validate',
    'review:read-any',
    'review:moderate-own',
  ],
  ADMINISTRATOR: [
    'identity:read-self',
    'identity:change-password',
    'merchant:onboard',
    'merchant:read-own',
    'merchant:update-own',
    'merchant:submit-for-verification',
    'merchant:verify',
    'merchant:reject',
    'admin:manage-users',
    'admin:view-audit',
    'catalog:read',
    'catalog:create',
    'catalog:update',
    'catalog:status',
    'listing:create',
    'listing:read-own',
    'listing:update-own',
    'listing:status-own',
    'listing:read-any',
    'listing:manage-any',
    'inventory:create',
    'inventory:read-own',
    'inventory:read-any',
    'inventory:adjust-own',
    'inventory:reserve',
    'inventory:release-own',
    'inventory:consume-own',
    'inventory:manage-any',
    'checkout:read-any',
    'checkout:manage-any',
    'order:read-any',
    'order:manage-any',
    'payment:read-own',
    'payment:manage-any',
    'fulfillment:create-own',
    'fulfillment:read-own',
    'fulfillment:update-own',
    'fulfillment:manage-any',
    'return:create-own',
    'return:read-own',
    'return:manage-own',
    'return:cancel-own',
    'return:manage-any',
    'settlement:read-own',
    'settlement:manage-any',
    'search:reindex',
    'search:manage',
    'events:read',
    'events:manage',
    'notifications:read',
    'notifications:manage',
    'analytics:read-own',
    'analytics:read-any',
    'analytics:rebuild',
    'recommendations:read',
    'recommendations:rebuild',
    'ml:read-own',
    'ml:read-any',
    'ml:train',
    'ml:manage',
    'ai:chat',
    'ai:documents:manage',
    'ai:documents:read',
    'ai:diagnostics:read',
    'promotion:create-own',
    'promotion:read-own',
    'promotion:update-own',
    'promotion:read-any',
    'promotion:manage-any',
    'promotion:validate',
    'customer:address:read-own',
    'customer:address:manage-own',
    'customer:address:read-any',
    'customer:address:manage-any',
    'review:create-own',
    'review:read-own',
    'review:update-own',
    'review:delete-own',
    'review:read-any',
    'review:moderate-own',
    'review:moderate-any',
    'wishlist:read-own',
    'wishlist:write-own',
    'back-in-stock:read-own',
    'back-in-stock:write-own',
  ],
};

export interface AuthorizedActor {
  userId: string;
  tenantId: string;
  role: Role;
}

export class RbacPolicy {
  static hasPermission(actor: AuthorizedActor, permission: Permission): boolean {
    const permissions = ROLE_PERMISSIONS[actor.role];
    return permissions.includes(permission);
  }

  static requirePermission(actor: AuthorizedActor, permission: Permission): void {
    if (!RbacPolicy.hasPermission(actor, permission)) {
      throw new ForbiddenError(
        `Actor role '${actor.role}' lacks permission '${permission}'`,
      );
    }
  }

  static isRole(actor: AuthorizedActor, role: Role): boolean {
    return actor.role === role;
  }

  static requireTenantMatch(actor: AuthorizedActor, resourceTenantId: string): void {
    if (actor.tenantId !== resourceTenantId) {
      throw new ForbiddenError(
        `Tenant isolation violation: actor tenant '${actor.tenantId}' cannot access resource in tenant '${resourceTenantId}'`,
      );
    }
  }
}
