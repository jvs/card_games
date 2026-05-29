// Substrate guarantees in TS: log completeness, no-leak, secret lifecycle,
// commit isolation, question seam, plus ASYNC: socket-style answerer and
// commit order-independence under concurrent async answers.
import { State, Card, Vis, Rng, Question, HAND_PUBLIC, PLAYER_VIEW,
         GameState, commit, choice, run, Answerer, Effect, Choice, Player } from "./cards.js";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => c ? (pass++, console.log("ok  " + m))
                                         : (fail++, console.error("FAIL " + m));

async function main() {

// --- deal fully reconstructable from own view; no leak to others ---
{
  const st = new State(["A","B","C"], new Rng(1));
  st.zone("deck", Vis.HIDDEN); st.zone("stash", Vis.HIDDEN);
  st.perPlayerZone("hand", Vis.OWNER);
  st.z("deck").cards = [];
  for (const s of ["X","Y"]) for (let r=1;r<=10;r++) st.z("deck").cards.push(Card.of({suit:s,rank:r}));
  st.shuffle("deck");
  for (const p of st.players) st.deal("deck", `hand:${p}`, 5);
  st.deal("deck","stash",5);
  for (const p of st.players) {
    const rebuilt = st.viewFor(p).filter(e=>e.type==="DealReveal"&&e.payload.dst===`hand:${p}`).map(e=>e.payload.card);
    ok(JSON.stringify(rebuilt)===JSON.stringify(st.hand(p).cards), `deal reconstructable for ${p}`);
  }
  const bLeak = st.viewFor("B").some(e=>e.type==="DealReveal"&&(e.payload.dst==="hand:A"||e.payload.dst==="hand:C"));
  ok(!bLeak, "no hand leaks to B");
  const stashSeen = st.players.some(p=>st.viewFor(p).some(e=>e.type==="DealReveal"&&e.payload.dst==="stash"));
  ok(!stashSeen, "stash hidden from everyone");
}

// --- secret visibility lifecycle: owner -> peek -> flip ---
{
  const st = new State(["A","B","C"], new Rng(0));
  st.newSecret("agenda:A","A","Hostile Takeover");
  const saw = (v:string)=>st.viewFor(v).some(e=>["SecretSet","SecretPeek","SecretFlip"].includes(e.type)&&e.payload.id==="agenda:A"&&e.payload.value==="Hostile Takeover");
  ok(saw("A")&&!saw("B")&&!saw("C"), "secret: initially owner-only");
  st.peekSecret("agenda:A","B");
  ok(saw("A")&&saw("B")&&!saw("C")&&!st.secrets["agenda:A"].public_, "secret: peek is private");
  st.flipSecret("agenda:A");
  ok(saw("A")&&saw("B")&&saw("C")&&st.secrets["agenda:A"].public_, "secret: flip is public");
}

// --- commit isolation: no committer sees another's commit while deciding ---
{
  const st = new GameState(["A","B","C"], new Rng(0));
  const seen: Record<string,number> = {};
  const spy: Answerer = { answer(req: Effect){ const r=req as Choice;
    seen[r.player]=st.log.filter(e=>e.type==="Proposal").length; return r.options[0]; } };
  function* game(): Generator<Effect, void, any> {
    const res = yield commit(["A","B","C"], (p)=>[`${p}-card`], "propose");
    for (const p of ["A","B","C"]) st.emit("Proposal", {exec:p, card:res[p]});
  }
  await run(game(), spy);
  ok(seen.A===0&&seen.B===0&&seen.C===0, "commit: no peeking at others");
  ok(st.log.filter(e=>e.type==="Proposal").length===3, "commit: all revealed after");
}

// --- question seam: both input kinds ---
{
  const st = new State(["A","B"], new Rng(0));
  st.perPlayerZone("hand", Vis.OWNER);
  st.hand("A").cards = [Card.of({suit:"X",rank:1}), Card.of({suit:"Y",rank:2})];
  const q1 = new Question("any X?", "(hand,pub)=>hand.some(c=>c.get('suit')==='X')", HAND_PUBLIC);
  ok(st.ask("B","A",q1)===true, "question HAND_PUBLIC");
  const asked = st.log.filter(e=>e.type==="Asked").at(-1)!;
  ok(asked.payload.question==="any X?" && asked.seenBy===null, "question logged publicly, rendered text");
  const q2 = new Question(">1 reveal?", "(view)=>view.filter(e=>e.type==='DealReveal').length>1", PLAYER_VIEW);
  st.z("deck"); // ensure no crash path
  ok(st.ask("B","A",q2)===false, "question PLAYER_VIEW (A has no deal events)");
}

// --- ASYNC: a socket-style answerer with real (out-of-order) delays drives a
//     game to completion, and a concurrent Commit yields the SAME result
//     regardless of answer arrival order. ---
{
  // A mock "network" seat: resolves after a delay, simulating round-trip
  // latency. Returns the option at a fixed index so results are checkable.
  class SocketAnswerer implements Answerer {
    constructor(private delayMs: number, private pickIndex = 0) {}
    answer(req: Choice): Promise<any> {
      return new Promise((res) =>
        setTimeout(() => res(req.options[this.pickIndex % req.options.length]), this.delayMs));
    }
  }

  // Order-independence: three players commit concurrently, each with a
  // DIFFERENT latency so they resolve out of order. The committed result must
  // depend only on each player's own choice, never on who answered first.
  const st = new GameState(["A","B","C"], new Rng(0));
  function* game(): Generator<Effect, Record<Player, string>, any> {
    const res = yield commit(["A","B","C"], (p) => [`${p}-1`, `${p}-2`], "propose");
    for (const p of ["A","B","C"]) st.emit("Proposal", { exec: p, card: res[p] });
    return res;
  }
  // B answers fastest, A slowest — arrival order A<B<C is scrambled to B<C<A.
  const seats = new Map<Player|null, Answerer>([
    ["A", new SocketAnswerer(30, 0)],
    ["B", new SocketAnswerer(5,  1)],
    ["C", new SocketAnswerer(15, 0)],
  ]);
  const result = await run(game(), seats);
  ok(result.A==="A-1" && result.B==="B-2" && result.C==="C-1",
     "async commit: each result matches that player's own pick, regardless of arrival order");
  // Proposals are emitted in player order (the game's loop order), not arrival
  // order — so the log is deterministic even though the network wasn't.
  const order = st.log.filter(e=>e.type==="Proposal").map(e=>e.payload.exec);
  ok(JSON.stringify(order)===JSON.stringify(["A","B","C"]),
     "async commit: reveal order is deterministic (game order, not arrival order)");

  // A full async game: drive Panther-style turns? Simpler — prove a sequential
  // async seat completes a multi-step generator.
  let steps = 0;
  function* seq(): Generator<Effect, number, any> {
    let acc = 0;
    for (let i=0;i<3;i++){ const v = yield choice("A", [i, i+10], "pick"); acc += v; steps++; }
    return acc;
  }
  const total = await run(seq(), new SocketAnswerer(3, 1)); // always picks i+10
  ok(steps===3 && total===(10+11+12), "async sequential: multi-step generator completes via awaited seat");
}

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
