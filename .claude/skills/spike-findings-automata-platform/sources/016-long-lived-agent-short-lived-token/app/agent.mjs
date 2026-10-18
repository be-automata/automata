// Long-lived agent PID 1 (spike 016): heartbeat from this boot; the work happens in turns.
import { writeFileSync } from "node:fs";
const bootId = Math.random().toString(36).slice(2, 8);
const beat = () => writeFileSync("/home/agent/heartbeat", JSON.stringify({ bootId, at: Date.now() }));
beat();
setInterval(beat, 100);
