import type { Locale, Theme } from "./constants.ts";
import type { EndpointModel, EndpointModelInput, ReaderEndpointModel, ReaderModel } from "./models.ts";
import type { SpeechSettings } from "./speech.ts";

export type Settings = {
  settings_rev?: number;
  workspace_path: string | null;
  endpoint_base_url: string | null;
  endpoint_key_set: boolean;
  endpoint_models: string[];
  endpoint_model_catalog: EndpointModel[];
  endpoint_default_model: string | null;
  default_provider_id: string | null;
  /**
   * The model that reads each line for what the app acts on (读句, ADR 0055); null follows the
   * default endpoint's default model. Null as well once the endpoint is gone or no longer lists it;
   * absent from a daemon older than that ADR.
   */
  reader_model?: ReaderModel | null;
  /**
   * The model that organizes the board, trace and plan (ADR 0075): the organizer, the scribe and the
   * pictures judged against a sample or between parts. An endpoint's model only; null follows the
   * default endpoint's default model. Null as well once the endpoint is gone or no longer lists it;
   * absent from a daemon older than that ADR.
   */
  organizer_model?: ReaderEndpointModel | null;
  /**
   * The speech endpoint the composer's microphone sends to (ADR 0073), changed through
   * `PATCH /v1/speech`; null until one is set up, absent from a daemon older than that ADR.
   */
  speech?: SpeechSettings | null;
  launch_at_login: boolean;
  locale: Locale;
  theme: Theme;
  wizard_complete: boolean;
};

export type SettingsPatch = {
  workspace_path?: string;
  endpoint_base_url?: string;
  endpoint_api_key?: string;
  endpoint_models?: EndpointModelInput[];
  endpoint_default_model?: string;
  default_provider_id?: string | null;
  /** Null follows the default model again. */
  reader_model?: ReaderModel | null;
  /** Null follows the default model again. */
  organizer_model?: ReaderEndpointModel | null;
  launch_at_login?: boolean;
  locale?: Locale;
  theme?: Theme;
};
