import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { problems, type FieldError } from '../common/problem';
import { oneParam } from '../common/query';
import { parse } from '../common/zod';
import { AccessService } from '../access/access.service';
import { RegistersService } from './registers.service';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const extendSchema = z.object({ to_date: day }).strict();
const topUpSchema = z.object({ requested_amount: z.number().min(0).max(1e9).optional(), period_to: day.optional() }).strict();

/**
 * Migration 0076 (contract 0.15.0): what the generic register endpoints lack for the Car Dispatcher and Financial Advances. The database decides every
 * rule (reservation overlap, link rule, readiness, amounts); the API checks the module and the region of the record first, through the registers service.
 */
@Injectable()
export class FleetService {
  constructor(private readonly registers: RegistersService, private readonly access: AccessService) {}

  /** POST /registers/car_dispatcher/records/{id}/extend : a child booking (draft) that extends the booking after its end. */
  async extendBooking(auth: AuthContext, id: string, raw: unknown): Promise<Record<string, unknown>> {
    const body = parse(extendSchema, raw);
    await this.access.requireRegions('car_dispatcher', 'create');
    await this.registers.get(auth, 'car_dispatcher', id);
    const nid = await this.registers.call<string>(auth, Prisma.sql`SELECT fleet_extend_booking(${id}::uuid, ${body.to_date}::date) AS r`);
    return this.registers.get(auth, 'car_dispatcher', nid);
  }

  /** POST /registers/financial_advances/records/{id}/top-up : a child advance (draft), a top-up and/or an extension of the period. */
  async topUp(auth: AuthContext, id: string, raw: unknown): Promise<Record<string, unknown>> {
    const body = parse(topUpSchema, raw);
    await this.access.requireRegions('financial_advances', 'create');
    await this.registers.get(auth, 'financial_advances', id);
    const nid = await this.registers.call<string>(auth, Prisma.sql`SELECT fin_top_up(${id}::uuid, ${body.requested_amount ?? 0}::numeric, ${body.period_to ?? null}::date) AS r`);
    return this.registers.get(auth, 'financial_advances', nid);
  }

  /** GET /fleet/availability?from=&to=&home_region=&vehicle_type=&exclude_booking_id= : the bookable vehicles that are free in the range. */
  async availability(auth: AuthContext, q: Record<string, unknown>): Promise<{ items: unknown[] }> {
    await this.access.requireRegions('car_dispatcher', 'view');
    const from = oneParam(q, 'from');
    const to = oneParam(q, 'to');
    const errs: FieldError[] = [];
    if (!from || !day.safeParse(from).success) errs.push({ path: '/from', code: 'invalid', message: 'from is a date (YYYY-MM-DD).' });
    if (!to || !day.safeParse(to).success) errs.push({ path: '/to', code: 'invalid', message: 'to is a date (YYYY-MM-DD).' });
    if (errs.length) throw problems.validation(errs);
    const items = await this.registers.call<unknown[]>(auth, Prisma.sql`
      SELECT fleet_availability(${from}::date, ${to}::date, ${oneParam(q, 'home_region') ?? null}::text, ${oneParam(q, 'vehicle_type') ?? null}::text,
        ${oneParam(q, 'exclude_booking_id') ?? null}::uuid) AS r`);
    return { items };
  }

  /** GET /registers/procurement/records/{id}/readiness : the derived readiness of the assignment, with the bookings and advances it waits for. */
  async readiness(auth: AuthContext, id: string): Promise<unknown> {
    const rec = await this.registers.get(auth, 'procurement', id);
    return this.registers.call<unknown>(auth, Prisma.sql`SELECT fleet_readiness(${rec.entity_id as string}::uuid) AS r`);
  }
}
