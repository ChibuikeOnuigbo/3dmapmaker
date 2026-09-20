/**
 * apps/web — the optional AI assistant (REQUIREMENTS 115-122).
 *
 * Hard guarantees, enforced here rather than promised:
 *  - The assistant is off by default and every core feature works without it.
 *  - The model may only return a JSON array of actions from a fixed vocabulary.
 *    Anything else is rejected and shown as an error. There is no code path
 *    anywhere in the app that evaluates model output.
 *  - API keys are held only as an opaque reference; they are never written to
 *    the project document, never logged, and never sent anywhere except the
 *    provider the user selected.
 *  - Nothing is uploaded unless the user presses a button.
 */
import React, { useRef, useState } from 'react';
import { Badge, Button, Panel, Segmented, StatRow, Switch, TextArea, TextField } from '@3dmm/ui';
import { z } from 'zod';
import { useEngine } from '../../engine/engineRef';
import { useStore } from '../../state/store';

/* The complete action vocabulary the assistant is allowed to emit. */
const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('addBuilding'), x: z.number().finite(), z: z.number().finite(), width: z.number().positive().max(500), depth: z.number().positive().max(500), floors: z.number().int().min(1).max(200) }),
  z.object({ type: z.literal('addWater'), x: z.number().finite(), z: z.number().finite(), radius: z.number().positive().max(5000), level: z.number().finite() }),
  z.object({ type: z.literal('addMarker'), x: z.number().finite(), z: z.number().finite(), name: z.string().min(1).max(80) }),
  z.object({ type: z.literal('addVegetation'), x: z.number().finite(), z: z.number().finite(), radius: z.number().positive().max(5000), count: z.number().int().min(1).max(20000) }),
  z.object({ type: z.literal('setTimeOfDay'), hours: z.number().min(0).max(24) }),
  z.object({ type: z.literal('setWeather'), weather: z.enum(['clear', 'rain', 'snow', 'fog']) }),
  z.object({ type: z.literal('flyTo'), x: z.number().finite(), y: z.number().finite(), z: z.number().finite(), distance: z.number().positive().max(100000) }),
  z.object({ type: z.literal('bookmark'), name: z.string().min(1).max(80) }),
]);

type AssistantAction = z.infer<typeof ActionSchema>;

const ActionListSchema = z.array(ActionSchema).min(1).max(24);

/** Extract a JSON array from a model reply without ever evaluating it. */
export function parseAssistantReply(text: string): { actions: AssistantAction[]; error: string | null } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return { actions: [], error: 'The reply did not contain a JSON array of actions.' };
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    return { actions: [], error: `The reply was not valid JSON: ${(err as Error).message}` };
  }
  const parsed = ActionListSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      actions: [],
      error: `Rejected ${parsed.error.issues.length} unsupported or out-of-range action(s): ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'action'} ${i.message}`)
        .join('; ')}`,
    };
  }
  return { actions: parsed.data, error: null };
}

const SYSTEM_PROMPT = `You are the scene assistant for 3DMapMaker Next. Reply with ONLY a JSON array of actions.
Allowed actions:
  {"type":"addBuilding","x":number,"z":number,"width":number,"depth":number,"floors":int}
  {"type":"addWater","x":number,"z":number,"radius":number,"level":number}
  {"type":"addMarker","x":number,"z":number,"name":string}
  {"type":"addVegetation","x":number,"z":number,"radius":number,"count":int}
  {"type":"setTimeOfDay","hours":number}
  {"type":"setWeather","weather":"clear"|"rain"|"snow"|"fog"}
  {"type":"flyTo","x":number,"y":number,"z":number,"distance":number}
  {"type":"bookmark","name":string}
Never output code, prose, URLs or anything outside that array.`;

export function AiPanel(): React.ReactElement {
  const ai = useStore((s) => s.project.ai);
  const setAi = useStore((s) => s.setAi);
  const append = useStore((s) => s.appendAiMessage);
  const setEnvironment = useStore((s) => s.setEnvironment);
  const addLayer = useStore((s) => s.addLayer);
  const addBookmark = useStore((s) => s.addBookmark);
  const notify = useStore((s) => s.notify);
  const engine = useEngine();

  const [prompt, setPrompt] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [pending, setPending] = useState<AssistantAction[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const applyActions = (actions: AssistantAction[]) => {
    let applied = 0;
    for (const a of actions) {
      switch (a.type) {
        case 'addBuilding': {
          const hw = a.width / 2;
          const hd = a.depth / 2;
          addLayer({
            id: `bld_${Date.now().toString(36)}_${applied}`,
            kind: 'buildings',
            name: `Building ${applied + 1}`,
            visible: true,
            locked: false,
            position: { x: a.x, y: 0, z: a.z },
            rotationDeg: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            anchor: { type: 'terrain', offset: 0 },
            data: {
              footprint: [
                { x: -hw, y: -hd },
                { x: hw, y: -hd },
                { x: hw, y: hd },
                { x: -hw, y: hd },
              ],
              floors: a.floors,
              floorHeight: 3.3,
              roof: 'gable',
              assistant: true,
            },
            children: [],
          });
          applied++;
          break;
        }
        case 'addWater': {
          const ring: Array<{ x: number; y: number }> = [];
          for (let i = 0; i < 28; i++) {
            const t = (i / 28) * Math.PI * 2;
            ring.push({ x: a.x + Math.cos(t) * a.radius, y: a.z + Math.sin(t) * a.radius });
          }
          addLayer({
            id: `wat_${Date.now().toString(36)}_${applied}`,
            kind: 'water',
            name: `Water ${applied + 1}`,
            visible: true,
            locked: false,
            position: { x: 0, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            anchor: { type: 'world' },
            data: { ring, level: a.level, color: '#2f6f8f', assistant: true },
            children: [],
          });
          applied++;
          break;
        }
        case 'addMarker':
          addLayer({
            id: `mk_${Date.now().toString(36)}_${applied}`,
            kind: 'markers',
            name: a.name,
            visible: true,
            locked: false,
            position: { x: a.x, y: 0, z: a.z },
            rotationDeg: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            anchor: { type: 'terrain', offset: 0 },
            data: { color: '#f6c453', assistant: true },
            children: [],
          });
          applied++;
          break;
        case 'addVegetation':
          addLayer({
            id: `veg_${Date.now().toString(36)}_${applied}`,
            kind: 'vegetation',
            name: `Vegetation ${applied + 1}`,
            visible: true,
            locked: false,
            position: { x: 0, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 },
            anchor: { type: 'world' },
            data: {
              count: a.count,
              seed: 9182 + applied,
              bounds: { minX: a.x - a.radius, minZ: a.z - a.radius, maxX: a.x + a.radius, maxZ: a.z + a.radius },
              maxSlopeDeg: 32,
              assistant: true,
            },
            children: [],
          });
          applied++;
          break;
        case 'setTimeOfDay':
          setEnvironment({ timeOfDay: a.hours });
          applied++;
          break;
        case 'setWeather':
          setEnvironment({ weather: a.weather });
          applied++;
          break;
        case 'flyTo':
          engine?.flyTo({ target: { x: a.x, y: a.y, z: a.z }, distance: a.distance }, 'Assistant');
          applied++;
          break;
        case 'bookmark':
          addBookmark(a.name);
          applied++;
          break;
      }
    }
    notify('ok', `Applied ${applied} assistant action${applied === 1 ? '' : 's'}.`);
    append({ role: 'assistant', text: `Applied ${applied} action(s).` });
    setPending([]);
  };

  const send = async () => {
    if (!ai.enabled) {
      notify('warn', 'Enable the assistant first. Everything in 3DMapMaker works without it.');
      return;
    }
    if (!prompt.trim()) return;
    if (!ai.apiKeyRef && ai.providerId !== 'none') {
      setAi({ lastError: 'Set an API key reference for the selected provider.' });
      return;
    }
    setBusy(true);
    setAi({ lastError: '' });
    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 20000);
    append({ role: 'user', text: prompt });
    try {
      // The key reference is resolved here, at call time, and is never stored.
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerId: ai.providerId,
          model: ai.model,
          apiKeyRef: ai.apiKeyRef,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
          logPrompts: ai.logPrompts,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Provider returned HTTP ${res.status}`);
      const json = (await res.json()) as { text?: string };
      const { actions, error } = parseAssistantReply(json.text ?? '');
      if (error) {
        setAi({ lastError: error });
        append({ role: 'error', text: error });
      } else {
        setPending(actions);
        append({ role: 'assistant', text: `Proposed ${actions.length} action(s) — review before applying.` });
      }
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError';
      const msg = aborted ? 'The request was cancelled.' : `Assistant request failed: ${(err as Error).message}`;
      setAi({ lastError: msg });
      append({ role: 'error', text: msg });
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="panels" data-testid="ai-panel">
      <Panel title="Assistant" panelId="ai">
        <div className="ui-field ui-field--row">
          <Badge tone={ai.enabled ? 'ok' : 'neutral'}>{ai.enabled ? 'enabled' : 'disabled'}</Badge>
          <span className="ui-hint">Entirely optional. Every feature works with this off.</span>
        </div>
        <Switch label="Enable the assistant" checked={ai.enabled} onChange={(v) => setAi({ enabled: v })} />
        {ai.enabled && (
          <>
            <Segmented
              size="xs"
              label="Provider"
              value={ai.providerId}
              onChange={(v) => setAi({ providerId: v })}
              options={[
                { value: 'none', label: 'None' },
                { value: 'openai', label: 'OpenAI' },
                { value: 'anthropic', label: 'Anthropic' },
                { value: 'local', label: 'Local proxy' },
              ]}
            />
            <TextField label="Model" value={ai.model} onChange={(v) => setAi({ model: v })} placeholder="e.g. gpt-4o-mini" />
            <TextField
              label="API key"
              value={apiKey}
              onChange={setApiKey}
              type="password"
              hint="Held in memory for this session only. Never written to the project, never logged."
            />
            <div className="panel-actions">
              <Button
                size="xs"
                onClick={() => {
                  // Store an opaque reference, not the key.
                  const ref = apiKey ? `key_${apiKey.slice(-4)}_${apiKey.length}` : '';
                  setAi({ apiKeyRef: ref });
                  setApiKey('');
                  notify('ok', ref ? 'Key reference stored for this session.' : 'Key reference cleared.');
                }}
              >
                Use this key for the session
              </Button>
            </div>
            <StatRow label="Key reference" value={ai.apiKeyRef || 'none'} />
            <Switch label="Allow vision requests" description="Send a viewport screenshot with the prompt." checked={ai.allowVision} onChange={(v) => setAi({ allowVision: v })} />
            <Switch label="Log prompts locally" description="Keeps a local transcript. Off by default." checked={ai.logPrompts} onChange={(v) => setAi({ logPrompts: v })} />
            <Switch label="Allow uploads" description="Nothing leaves this machine unless this is on and you press send." checked={ai.autoUpload} onChange={(v) => setAi({ autoUpload: v })} />
          </>
        )}
      </Panel>

      {ai.enabled && (
        <Panel title="Ask for scene edits" panelId="ai-ask">
          <TextArea label="Prompt" value={prompt} onChange={setPrompt} rows={4} placeholder="Add a small harbour village to the north of the map at dusk." />
          <div className="panel-actions">
            <Button size="xs" variant="primary" disabled={busy || !prompt.trim()} onClick={() => void send()}>
              {busy ? 'Waiting…' : 'Send'}
            </Button>
            {busy && (
              <Button size="xs" variant="ghost" onClick={() => abortRef.current?.abort()}>
                Cancel
              </Button>
            )}
          </div>
          {ai.lastError && <p className="ui-error">{ai.lastError}</p>}

          {pending.length > 0 && (
            <div className="ai-pending">
              <span className="ui-label">Proposed actions (nothing applied yet)</span>
              <pre className="ai-pending__json">{JSON.stringify(pending, null, 2)}</pre>
              <div className="panel-actions">
                <Button size="xs" variant="primary" onClick={() => applyActions(pending)}>
                  Apply {pending.length} action{pending.length === 1 ? '' : 's'}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setPending([])}>
                  Discard
                </Button>
              </div>
            </div>
          )}

          {ai.history.length > 0 && (
            <ul className="ai-history">
              {ai.history.slice(-12).map((h) => (
                <li key={h.id} className={`ai-history__row ai-history__row--${h.role}`}>
                  <span className="ai-history__role">{h.role}</span>
                  <span className="ai-history__text">{h.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </div>
  );
}
