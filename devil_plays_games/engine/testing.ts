/**
 * engine/testing — answerers used only by tests/scenarios, kept OUT of core
 * (which is production substrate). A scripted answerer has no role in a running
 * game, server, or simulator; it belongs with the things that test them.
 */
import { Answerer, Choice } from "./core.js";

export class ScriptedAnswerer implements Answerer {
  private i = 0;
  constructor(private answers: any[], private fallback?: Answerer) {}
  answer(req: Choice): any {
    if (this.i < this.answers.length) {
      const a = this.answers[this.i++];
      if (typeof a === "function") return req.options.find(a);
      return a;
    }
    if (this.fallback) return this.fallback.answer(req);
    throw new Error(`script exhausted at request: ${req.key}`);
  }
}
