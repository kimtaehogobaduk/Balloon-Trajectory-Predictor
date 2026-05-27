import { useMutation } from "@tanstack/react-query";
import type { UseMutationResult } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";
import type { SimulationResult } from "./generated/api.schemas";

export interface PlanInput {
  launch_lat: number;
  launch_lng: number;
  target_lat: number;
  target_lng: number;
  payload_mass_g: number;
  launch_datetime: string;
}

export interface FlightCase {
  case_number: number;
  label: string;
  description: string;
  strategy: string;
  balloon_mass_g: number;
  helium_volume_m3: number;
  parachute_type: string;
  parachute_diameter_m: number;
  parachute_cd: number;
  distance_to_target_km: number;
  simulation: SimulationResult;
}

export interface RecommendedWindow {
  datetime: string;
  label: string;
  best_distance_km: number;
  feasibility: "good" | "marginal" | "infeasible";
}

export interface PlanResult {
  cases: FlightCase[];
  wind_data_fetched_at: string;
  launch_to_target_km: number;
  feasible: boolean;
  feasibility_grade: "good" | "marginal" | "infeasible";
  feasibility_reason: string;
  recommended_windows: RecommendedWindow[];
}

export const planFlightRequest = async (input: PlanInput): Promise<PlanResult> => {
  return customFetch<PlanResult>(`/api/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
};

export const usePlanFlight = (): UseMutationResult<PlanResult, Error, PlanInput> => {
  return useMutation<PlanResult, Error, PlanInput>({
    mutationFn: (input: PlanInput) => planFlightRequest(input),
  });
};
