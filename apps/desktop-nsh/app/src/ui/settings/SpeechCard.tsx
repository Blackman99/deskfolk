/**
 * The speech endpoint the composer's microphone sends to (ADR 0073; `settings/SpeechCard.svelte`).
 * Picking a service fills in its format, address and model; every field saves as it changes, the key
 * when you leave it. A Bailian or Xiaomi MiMo endpoint already set up is offered as a shortcut:
 * speech then takes that endpoint's key. It is Settings › Models' Speech recognition section, whose
 * intro says what it is for.
 *
 * Props: `speech` (as the daemon has it; null until a service is picked); `providers` (the model
 * endpoints, for the shortcut); `patch(body)` (resolves null when it saved).
 *
 * Not carried over: the model field's `<datalist>` of the preset's model names (NSH's `Input` has
 * no suggestion list), so the names are typed. Test ids: `speech-enabled`, `speech-shortcut-<id>`,
 * `speech-shortcut-use-<id>`, `speech-service`, `speech-format`, `speech-base-url`, `speech-model`,
 * `speech-language`, `speech-key`, `speech-key-linked`, `speech-key-unlink`, `speech-key-clear`,
 * `speech-status`, `speech-error`.
 */
import { effect, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import {
  SPEECH_FORMATS,
  SPEECH_LANGUAGES,
  SPEECH_PRESETS,
  isLocalEndpoint,
  speechPreset,
  speechReady,
  type PatchSpeechRequest,
  type Provider,
  type SpeechPresetId,
  type SpeechSettings,
} from "@real-bot/protocol";
import { copy } from "../../runtime";
import type { Copy } from "../../m/copy.ts";
import { Autosave } from "../../m/autosave.svelte.ts";
import { speechServiceSource } from "../../m/model-source.ts";
import { offeredShortcuts, type SpeechShortcut } from "../../m/settings/speech-shortcut.ts";
import { Select } from "../Select";
import { Switch } from "../Switch";
import { AutosaveState } from "./AutosaveState";
import { widthAtMost } from "../../platform/viewport";

/** What a speech endpoint still lacks before the microphone shows; null once it has it all. */
export function speechMissing(speech: SpeechSettings, s: Copy["speech"]): string | null {
  if (speechReady(speech)) return null;
  if (!speech.base_url) return s.missingUrl;
  if (!speech.model) return s.missingModel;
  return s.missingKey;
}

const FIELD = "w-full min-w-0 text-[13px] text-ink bg-input-bg border border-line rounded-(--radius-sm) px-[10px] py-[6px] focus:border-field-focus-border";

export function SpeechCard(props: {
  speech: SpeechSettings | null;
  providers?: readonly Provider[];
  patch: (patch: PatchSpeechRequest) => Promise<unknown | null>;
}) {
  const t = () => copy();
  const s = () => copy().speech;
  const autosave = new Autosave();
  const failed = signal(false);
  const baseUrl = signal("");
  const model = signal("");
  const apiKey = signal("");
  /** Fields typed into and not saved yet: the snapshot does not overwrite them. */
  const editing = signal<{ base_url: boolean; model: boolean }>({ base_url: false, model: false });

  effect(() => {
    const current = props.speech;
    const typing = editing();
    if (!typing.base_url) baseUrl.set(current?.base_url ?? "");
    if (!typing.model) model.set(current?.model ?? "");
  });

  const speech = () => props.speech;
  const shortcuts = () => offeredShortcuts(props.providers ?? [], props.speech);
  /** The endpoint whose key speech takes, when it takes one. */
  const keyProvider = () => {
    const id = props.speech?.key_provider_id;
    return id ? ((props.providers ?? []).find((row) => row.id === id) ?? null) : null;
  };
  const local = () => isLocalEndpoint(baseUrl().trim());
  const presetOptions = () => SPEECH_PRESETS.map((row) => ({ value: row.id, label: s().presets[row.id], source: speechServiceSource(row.id, t()) }));
  const formatOptions = () => SPEECH_FORMATS.map((format) => ({ value: format, label: s().formats[format] }));
  /** Xiaomi MiMo takes only Chinese or English; any other it turns away. */
  const languages = () => (props.speech?.format === "mimo" ? SPEECH_LANGUAGES.filter((code) => code === "zh" || code === "en") : SPEECH_LANGUAGES);
  const languageOptions = () => [{ value: "", label: s().languageAuto }, ...languages().map((code) => ({ value: code, label: s().languages[code] ?? code }))];
  const status = () => {
    const current = props.speech;
    if (!current) return null;
    if (!current.enabled) return s().off;
    return speechMissing(current, s()) ?? s().ready;
  };
  /** Two columns on a wide window, one on a phone. */
  const half = (): { width: `${number}%` } => ({ width: widthAtMost(720) ? "100%" : "48.5%" });
  const wide: { width: `${number}%` } = { width: "100%" };

  async function save(body: PatchSpeechRequest): Promise<boolean> {
    autosave.saving = true;
    failed.set(false);
    try {
      const error = await props.patch(body);
      failed.set(error !== null);
      if (!failed()) autosave.savedTick++;
      return !failed();
    } finally {
      autosave.saving = false;
    }
  }

  /** A language the new format does not take goes back to detection, so the picker shows what is sent. */
  function withLanguage(body: PatchSpeechRequest): PatchSpeechRequest {
    const kept = body.format === "mimo" ? ["zh", "en"] : SPEECH_LANGUAGES;
    return props.speech?.language && !(kept as readonly string[]).includes(props.speech.language) ? { ...body, language: null } : body;
  }

  function useShortcut(shortcut: SpeechShortcut): void {
    autosave.cancel();
    editing.set({ base_url: false, model: false });
    void save(withLanguage(shortcut.patch));
  }

  /** A service fills in its own format, address and model; custom keeps what is there to edit. */
  function choosePreset(id: string): void {
    const next = speechPreset(id as SpeechPresetId);
    autosave.cancel();
    editing.set({ base_url: false, model: false });
    void save(next.id === "custom" ? { preset: next.id } : withLanguage({ preset: next.id, format: next.format, base_url: next.base_url, model: next.model }));
  }

  function typed(field: "base_url" | "model"): void {
    editing.set({ ...editing(), [field]: true });
    autosave.schedule(() => void flush());
  }

  async function flush(): Promise<void> {
    const body: PatchSpeechRequest = {};
    if (editing().base_url) body.base_url = baseUrl().trim();
    if (editing().model) body.model = model().trim();
    if (!Object.keys(body).length) return;
    const done = await save(body);
    if (done) editing.set({ base_url: false, model: false });
  }

  async function saveKey(): Promise<void> {
    const value = apiKey().trim();
    if (!value) return;
    if (await save({ api_key: value })) apiKey.set("");
  }

  const label = (text: string) => <Text class="text-[12px] font-semibold text-ink-secondary">{text}</Text>;
  const smallButton = (testID: string, text: string, onPress: () => void) => (
    <View
      role="button"
      testID={testID}
      accessibilityLabel={text}
      disabled={autosave.saving}
      onPress={onPress}
      class="shrink-0 px-[10px] py-[5px] rounded-(--radius-sm) bg-sidebar-bg border border-line group disabled:opacity-[0.55]"
    >
      <Text class="text-[12px] text-ink-secondary group-hover:text-danger-text">{text}</Text>
    </View>
  );

  return (
    <View testID="speech-settings" accessibilityLabel={s().title} role="region" class="flex-col gap-3 min-w-0 px-[14px] py-3 bg-pane border border-line rounded-(--radius-md)">
      <If when={speech()}>
        {(current) => (
          <View class="flex-row items-center justify-between gap-3">
            <Text class="text-[13px] font-semibold text-ink">{s().enabled}</Text>
            <Switch testID="speech-enabled" label={s().enabled} checked={current().enabled} disabled={autosave.saving} onChange={(checked) => void save({ enabled: checked })} />
          </View>
        )}
      </If>

      <Each of={shortcuts()} key={(shortcut) => shortcut.provider.id}>
        {(shortcut) => (
          <View testID={`speech-shortcut-${shortcut().provider.id}`} class="flex-row items-center gap-[10px] px-[10px] py-2 border border-accent-border rounded-(--radius-sm) bg-accent-tint">
            <Text class="grow shrink min-w-0 text-[12px] leading-[1.45] text-ink-secondary">
              {s().shortcut(
                s().shortcutVendor[shortcut().connector],
                shortcut().provider.name,
                (t().connectors.plan as Record<string, string>)[shortcut().planKey] ?? shortcut().planKey,
              )}
            </Text>
            <View
              role="button"
              testID={`speech-shortcut-use-${shortcut().provider.id}`}
              accessibilityLabel={s().shortcutUse}
              disabled={autosave.saving}
              onPress={() => useShortcut(shortcut())}
              class="shrink-0 px-[10px] py-[5px] rounded-(--radius-sm) bg-brand disabled:opacity-[0.55]"
            >
              <Text class="text-[12px] font-semibold text-on-accent">{s().shortcutUse}</Text>
            </View>
          </View>
        )}
      </Each>

      <View class="flex-row flex-wrap gap-x-3 gap-y-[10px]">
        <View class="flex-col gap-1 min-w-0" style={half()}>
          {label(s().service)}
          <Select
            testID="speech-service"
            value={speech()?.preset ?? ""}
            options={presetOptions()}
            placeholder={s().service}
            size="sm"
            ariaLabel={s().service}
            disabled={autosave.saving}
            onChange={choosePreset}
          />
        </View>
        <If when={speech()}>
          {(current) => (
            <>
              <If when={current().preset === "custom"}>
                <View class="flex-col gap-1 min-w-0" style={half()}>
                  {label(s().format)}
                  <Select
                    testID="speech-format"
                    value={current().format}
                    options={formatOptions()}
                    size="sm"
                    ariaLabel={s().format}
                    disabled={autosave.saving}
                    onChange={(value) => void save(withLanguage({ format: value as SpeechSettings["format"] }))}
                  />
                </View>
              </If>
              <View class="flex-col gap-1 min-w-0" style={wide}>
                {label(s().baseUrl)}
                <Input
                  testID="speech-base-url"
                  accessibilityLabel={s().baseUrl}
                  value={baseUrl()}
                  placeholder="https://…/v1"
                  autoCapitalize="none"
                  autoCorrect={false}
                  class={`font-mono ${FIELD}`}
                  onChange={(e) => {
                    baseUrl.set(e.value);
                    typed("base_url");
                  }}
                  onBlur={() => {
                    if (autosave.cancel()) void flush();
                  }}
                />
                <Text class="text-[12px] leading-[1.45] text-ink-muted">{current().format === "dashscope" ? s().baseUrlHintDashscope : s().baseUrlHint}</Text>
              </View>
              <View class="flex-col gap-1 min-w-0" style={half()}>
                {label(s().model)}
                <Input
                  testID="speech-model"
                  accessibilityLabel={s().model}
                  value={model()}
                  autoCapitalize="none"
                  autoCorrect={false}
                  class={`font-mono ${FIELD}`}
                  onChange={(e) => {
                    model.set(e.value);
                    typed("model");
                  }}
                  onBlur={() => {
                    if (autosave.cancel()) void flush();
                  }}
                />
              </View>
              <If when={current().format !== "dashscope"}>
                <View class="flex-col gap-1 min-w-0" style={half()}>
                  {label(s().language)}
                  <Select
                    testID="speech-language"
                    value={current().language ?? ""}
                    options={languageOptions()}
                    size="sm"
                    ariaLabel={s().language}
                    disabled={autosave.saving}
                    onChange={(value) => void save({ language: value || null })}
                  />
                </View>
              </If>
              <View class="flex-col gap-1 min-w-0" style={wide}>
                {label(s().apiKey)}
                <If
                  when={keyProvider()}
                  else={
                    <View class="flex-row items-center gap-2">
                      <Input
                        testID="speech-key"
                        accessibilityLabel={s().apiKey}
                        masked
                        value={apiKey()}
                        placeholder={current().key_set ? s().keySaved : local() ? s().keyNotNeeded : ""}
                        autoCapitalize="none"
                        autoCorrect={false}
                        autoComplete="off"
                        class={`grow shrink ${FIELD}`}
                        onChange={(e) => apiKey.set(e.value)}
                        onBlur={() => void saveKey()}
                        onSubmit={() => void saveKey()}
                      />
                      <If when={current().key_set}>{smallButton("speech-key-clear", s().keyClear, () => void save({ api_key: "" }))}</If>
                    </View>
                  }
                >
                  {(linked) => (
                    <View testID="speech-key-linked" class="flex-row items-center gap-2">
                      <Text class="grow shrink min-w-0 py-[6px] text-[13px] text-ink">{s().keyLinked(linked().name)}</Text>
                      {smallButton("speech-key-unlink", s().keyUnlink, () => void save({ key_provider_id: null }))}
                    </View>
                  )}
                </If>
              </View>
            </>
          )}
        </If>
      </View>

      <If
        when={speech()}
        else={
          <If when={failed()}>
            <Text role="alert" testID="speech-error" class="text-[12px] text-danger-text">
              {s().failed}
            </Text>
          </If>
        }
      >
        {(current) => (
          <View class="flex-row flex-wrap items-center justify-between gap-3">
            <Text testID="speech-status" class={`text-[12px] ${speechReady(current()) ? "text-ok-text" : "text-warn-text"}`}>
              {status()}
            </Text>
            <AutosaveState saving={autosave.saving} failed={failed()} saved={autosave.savedTick > 0} />
          </View>
        )}
      </If>
    </View>
  );
}
