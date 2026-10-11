import type { FastifyInstance } from 'fastify';
import type { IdentityService } from '../modules/identity/index.js';
import type { CustomerAddressService } from '../modules/customer/index.js';
import { createAuthMiddleware, requireActor } from './auth-middleware.js';
import type {
  CreateAddressInput,
  UpdateAddressInput,
} from '../modules/customer/index.js';

export function registerCustomerAddressRoutes(
  app: FastifyInstance,
  identityService: IdentityService,
  addressService: CustomerAddressService,
): void {
  const authenticate = createAuthMiddleware(identityService);

  const routePrefixes = ['', '/v1', '/api/v1'];

  for (const prefix of routePrefixes) {
    // GET /customer/addresses: List all addresses for current authenticated customer
    app.get(
      `${prefix}/customer/addresses`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const addresses = await addressService.listAddresses(actor);
        return reply.status(200).send(addresses);
      },
    );

    // GET /customer/addresses/default: Get customer's default address
    app.get(
      `${prefix}/customer/addresses/default`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const address = await addressService.getDefaultAddress(actor);
        return reply.status(200).send({ address });
      },
    );

    // POST /customer/addresses: Create a new address
    app.post(
      `${prefix}/customer/addresses`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const body = request.body as CreateAddressInput;
        const created = await addressService.createAddress(actor, body);
        return reply.status(201).send(created);
      },
    );

    // GET /customer/addresses/:id: Get specific address
    app.get(
      `${prefix}/customer/addresses/:id`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { id } = request.params as { id: string };
        const address = await addressService.getAddress(actor, id);
        return reply.status(200).send(address);
      },
    );

    // PATCH /customer/addresses/:id: Update address
    app.patch(
      `${prefix}/customer/addresses/:id`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { id } = request.params as { id: string };
        const body = request.body as UpdateAddressInput;
        const updated = await addressService.updateAddress(actor, id, body);
        return reply.status(200).send(updated);
      },
    );

    // DELETE /customer/addresses/:id: Delete address
    app.delete(
      `${prefix}/customer/addresses/:id`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { id } = request.params as { id: string };
        await addressService.deleteAddress(actor, id);
        return reply.status(204).send();
      },
    );

    // POST /customer/addresses/:id/default: Set address as default
    app.post(
      `${prefix}/customer/addresses/:id/default`,
      { preHandler: authenticate },
      async (request, reply) => {
        const actor = requireActor(request);
        const { id } = request.params as { id: string };
        const updated = await addressService.setDefaultAddress(actor, id);
        return reply.status(200).send(updated);
      },
    );
  }

  // Inter-service microservice aliases for HttpCustomerAddressClient (/v1/customers/addresses/*)
  app.get(
    '/v1/customers/addresses/default',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const address = await addressService.getDefaultAddress(actor);
      return reply.status(200).send({ address });
    },
  );

  app.get(
    '/v1/customers/addresses/:id',
    { preHandler: authenticate },
    async (request, reply) => {
      const actor = requireActor(request);
      const { id } = request.params as { id: string };
      const address = await addressService.getAddress(actor, id);
      return reply.status(200).send({ address });
    },
  );
}
