// Downloads pump.fun's official IDLs (pump, pump_amm, pump_fees) into ./idl.
// Re-run whenever pump.fun announces a program update.
import { mkdir, writeFile } from "node:fs/promises";

const BASE = "https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl";
await mkdir(new URL("../idl/", import.meta.url), { recursive: true });
for (const name of ["pump", "pump_amm", "pump_fees"]) {
  const res = await fetch(`${BASE}/${name}.json`);
  if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
  await writeFile(new URL(`../idl/${name}.json`, import.meta.url), await res.text());
  console.log(`saved idl/${name}.json`);
}
