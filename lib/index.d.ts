import Schema from '@deepseek-ai/schemastery';
export declare const name = "dsh-herdr-site";
/** We only subscribe to host events; no `inject` requirement beyond the bus. */
export declare const inject: string[];
export interface Config {
    /** Override text included with the `blocked` report. */
    blockMessage?: string;
}
export declare const Config: Schema<Schemastery.ObjectS<{
    blockMessage: Schema<string, string>;
}>, Schemastery.ObjectT<{
    blockMessage: Schema<string, string>;
}>>;
/**
 * dsh-herdr-site plugin entry.
 *
 * Design notes for the blocked heuristic:
 *  - dsh exposes exactly two `agent/status` values (`idle`, `running`); there
 *    is no native `blocked`. Herdr has three; we map 1:1 for the common case
 *    and *lift* `running → blocked` while an `ask_user_question` tool call is
 *    parked. The model keeps running the whole time it waits, so without this
 *    lift Herdr would show `working` even though the agent genuinely needs a
 *    human decision. The lift is derived from the durable event stream, so it
 *    survives replay and needs no UI-provider hook.
 *  - Reports are de-duplicated (`rt.last`) and seq-guarded, and release only
 *    on host dispose, matching Herdr's ownership model.
 */
export declare function apply(ctx: import('@deepseek-ai/cordis').Context, config: Partial<Config>): Promise<void>;
//# sourceMappingURL=index.d.ts.map