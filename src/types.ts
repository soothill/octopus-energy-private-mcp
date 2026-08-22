export type Fuel = "electricity" | "gas";
export type Direction = "import" | "export";
export type GasConsumptionUnit = "auto" | "kwh" | "m3";
export type EvChargeCostFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

export interface Agreement {
  tariff_code: string;
  valid_from: string;
  valid_to: string | null;
}

export interface Meter {
  serial_number: string;
  registers?: Array<{
    identifier: string;
    rate: string;
    is_settlement_register: boolean;
  }>;
}

export interface ElectricityMeterPoint {
  mpan: string;
  profile_class?: number;
  consumption_standard?: number;
  meters: Meter[];
  agreements: Agreement[];
  is_export: boolean;
}

export interface GasMeterPoint {
  mprn: string;
  consumption_standard?: number;
  meters: Meter[];
  agreements: Agreement[];
}

export interface Property {
  id: number;
  moved_in_at: string | null;
  moved_out_at: string | null;
  address_line_1?: string;
  address_line_2?: string;
  address_line_3?: string;
  town?: string;
  county?: string;
  postcode?: string;
  electricity_meter_points: ElectricityMeterPoint[];
  gas_meter_points: GasMeterPoint[];
}

export interface Account {
  number: string;
  properties: Property[];
}

export interface Product {
  code: string;
  direction: string;
  full_name: string;
  display_name: string;
  description?: string;
  is_variable: boolean;
  is_green: boolean;
  is_tracker?: boolean;
  is_prepay: boolean;
  is_business: boolean;
  is_restricted?: boolean;
  term: number | null;
  available_from: string;
  available_to: string | null;
  brand?: string;
  [key: string]: unknown;
}

export interface ConsumptionRecord {
  consumption: number;
  interval_start: string;
  interval_end: string;
}

export interface RateRecord {
  value_exc_vat: number;
  value_inc_vat: number;
  valid_from: string;
  valid_to: string | null;
  payment_method: string | null;
}

export interface PagedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export type CacheStatus = "disabled" | "hit" | "miss" | "stale" | "mixed";

export interface CacheProvenance {
  cache_status: CacheStatus;
  stale_cache_used: boolean;
  cache_age_ms?: number;
}

export interface EvChargeCostRecord {
  costOfChargeId: string | null;
  isSmartCharge: boolean | null;
  krakenflexDeviceId: string | null;
  reportDate: string | null;
  totalConsumption: number | null;
  totalCostExclTax: number | null;
  totalCostInclTax: number | null;
}

export interface EvChargeCostsResponse extends CacheProvenance {
  costOfCharge: EvChargeCostRecord[];
}

export interface FourRateEvTariff {
  id: string | null;
  tariffCode: string | null;
  productCode: string | null;
  displayName: string | null;
  fullName: string | null;
  isExport: boolean | null;
  dayRate: number | null;
  nightRate: number | null;
  evDevicePeakRate: number | null;
  evDeviceOffPeakRate: number | null;
  standingCharge: number | null;
  preVatDayRate: number | null;
  preVatNightRate: number | null;
  preVatEvDevicePeakRate: number | null;
  preVatEvDeviceOffPeakRate: number | null;
  preVatStandingCharge: number | null;
}

export interface FourRateEvAgreement {
  agreementId: string | null;
  validFrom: string | null;
  validTo: string | null;
  meterPoint: string | null;
  tariff: FourRateEvTariff;
}

export interface EvTariffPricingResponse extends CacheProvenance {
  activeAgreementCount: number;
  fourRateTariffs: FourRateEvAgreement[];
}

export interface PaginatedResult<T> extends CacheProvenance {
  count: number;
  results: T[];
  pages_fetched: number;
  truncated: boolean;
}

export interface MeterDescriptor {
  property_id: number;
  property_active: boolean;
  fuel: Fuel;
  direction: Direction;
  meter_point: string;
  serial_number: string;
  agreements: Agreement[];
  active_tariff_code: string | null;
  consumption_standard: number | null;
}

export interface PeriodRange {
  from: string;
  to: string;
  label: string;
}

export interface UsageBucket {
  period: string;
  consumption: number;
  intervals: number;
}

export interface UsageAnalysis {
  unit: "kWh" | "m3" | "unknown";
  source_unit: "kWh" | "m3" | "unknown";
  conversion_factor: number | null;
  total: number;
  interval_count: number;
  average_per_interval: number;
  average_per_day: number;
  period_from: string | null;
  period_to: string | null;
  days_covered: number;
  peak_intervals: ConsumptionRecord[];
  lowest_non_zero_intervals: ConsumptionRecord[];
  by_day: UsageBucket[];
  by_month: UsageBucket[];
  by_hour_of_day: Array<{ hour: number; total: number; average: number; intervals: number }>;
  by_weekday: Array<{ weekday: string; total: number; average: number; intervals: number }>;
  data_quality: {
    expected_half_hour_intervals: number;
    observed_unique_intervals: number;
    coverage_percent: number;
    duplicate_intervals: number;
    gaps: Array<{ after: string; before: string; minutes: number }>;
  };
  warnings: string[];
}

export interface TariffTarget {
  label?: string;
  fuel: Fuel;
  product_code: string;
  tariff_code: string;
}

export interface CostEstimate {
  label: string;
  product_code: string;
  tariff_code: string;
  fuel: Fuel;
  consumption_kwh: number;
  unit_cost_pence: number;
  standing_charge_pence: number;
  total_cost_pence: number;
  total_cost_gbp: number;
  priced_intervals: number;
  unpriced_intervals: number;
  standing_charge_days: number;
  rate_coverage_percent: number;
  warnings: string[];
}
