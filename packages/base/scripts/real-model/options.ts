export function probeOptions(values: { scenario?: string; notice?: string; changeNotice?: boolean }) {
  const scenario = values.scenario ?? "full";
  if (scenario !== "full" && scenario !== "prompt-change") throw new Error("unsupported_probe_scenario");
  const notice = values.notice ?? (values.changeNotice ? "specific" : "generic");
  if (notice !== "none" && notice !== "generic" && notice !== "specific") throw new Error("unsupported_probe_notice");
  if (values.changeNotice && notice !== "specific") throw new Error("conflicting_probe_notice");
  return { scenario, notice };
}
