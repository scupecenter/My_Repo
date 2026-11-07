import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './client';
import type { RegisterRecord } from './types';

/** Contract 0.15.0: fleet availability, assignment readiness, booking extension and advance top-up. */
export type FleetVehicle = { vehicle_id: string; plate_no: string; vehicle_type?: string | null; model?: string | null; home_region?: string | null; driver_name?: string | null };
export type Readiness = { readiness: 'awaiting_vehicle' | 'awaiting_advance' | 'awaiting_both' | 'ready_to_mobilize' | null; ready_date?: string | null; approved: boolean };
export type FleetQuery = { from?: string; to?: string; home_region?: string; vehicle_type?: string; exclude_booking_id?: string };

export const useFleetAvailability = (q: FleetQuery) =>
  useQuery({
    queryKey: ['fleet-availability', q], enabled: !!q.from && !!q.to && q.from <= q.to,
    queryFn: () => api.get<{ items: FleetVehicle[] }>('/fleet/availability', { query: { ...q } }).then((r) => r.items),
  });

export const useReadiness = (id: string | null) =>
  useQuery({ queryKey: ['readiness', id], enabled: !!id, queryFn: () => api.get<Readiness>(`/registers/procurement/records/${id}/readiness`) });

export const useExtendBooking = (id: string) => {
  const qc = useQueryClient();
  return useMutation<RegisterRecord, ApiError, { to_date: string }>({
    mutationFn: (body) => api.post(`/registers/car_dispatcher/records/${id}/extend`, { body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['register-records', 'car_dispatcher'] }),
  });
};

export const useTopUp = (id: string) => {
  const qc = useQueryClient();
  return useMutation<RegisterRecord, ApiError, { requested_amount?: number; period_to?: string }>({
    mutationFn: (body) => api.post(`/registers/financial_advances/records/${id}/top-up`, { body }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['register-records', 'financial_advances'] }),
  });
};
