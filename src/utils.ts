import type { DiffToken, SignItem, TermBinding } from "./types";

export function estimatedLines(text: string, width: number, fontSize: number, lineHeight = 1.25) {
  if (!text.trim()) return [];
  const usable = Math.max(120, width - 48);
  const lines: string[] = [];
  for (const hardLine of text.split("\n")) {
    if (!hardLine) {
      lines.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const char of hardLine) {
      const charWidth = /[\u2e80-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char)
        ? fontSize
        : char === " "
          ? fontSize * 0.34
          : fontSize * 0.58;
      if (current && currentWidth + charWidth > usable) {
        lines.push(current.trimEnd());
        current = char.trimStart();
        currentWidth = charWidth;
      } else {
        current += char;
        currentWidth += charWidth;
      }
    }
    if (current) lines.push(current.trimEnd());
  }
  return lines;
}

export function analyzeSign(sign: SignItem, width: number, fontSize: number) {
  const lines = estimatedLines(sign.targetText, width, fontSize);
  const lineCapacity = Math.max(1, Math.floor((width * 0.62) / (fontSize * 1.25)));
  const visible = lines.slice(0, lineCapacity);
  const overflow = lines.length > lineCapacity;
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const estimatedCharacterLimit = Math.max(12, Math.floor((width - 48) / (fontSize * 0.55)) * lineCapacity);
  const tooLong = sign.targetText.replace(/\s/g, "").length > estimatedCharacterLimit;
  const missingTerms = sign.terms.filter(
    (term) => term.required && !sign.targetText.toLocaleLowerCase().includes(term.target.toLocaleLowerCase()),
  );
  return {
    lines,
    visible,
    overflow,
    tooLong,
    missingTerms,
    risk: overflow || tooLong || missingTerms.length ? "high" : lines.length >= lineCapacity - 1 ? "medium" : "low",
  };
}

function tokenize(value: string) {
  return value.match(/[\u3400-\u9fff]|[A-Za-zÀ-ÿ0-9'’\-]+|\s+|./gu) ?? [];
}

function lcsTable(left: string[], right: string[]) {
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

export function diffText(oldText: string, newText: string): DiffToken[] {
  const left = tokenize(oldText);
  const right = tokenize(newText);
  if (left.length * right.length > 180000) {
    return [{ type: "remove", value: oldText }, { type: "add", value: newText }];
  }
  const table = lcsTable(left, right);
  const tokens: DiffToken[] = [];
  let i = 0;
  let j = 0;
  const push = (type: DiffToken["type"], value: string) => {
    const previous = tokens.at(-1);
    if (previous?.type === type) previous.value += value;
    else tokens.push({ type, value });
  };
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      push("same", left[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push("remove", left[i]);
      i += 1;
    } else {
      push("add", right[j]);
      j += 1;
    }
  }
  while (i < left.length) push("remove", left[i++]);
  while (j < right.length) push("add", right[j++]);
  return tokens;
}

export function cloneTerms(terms: TermBinding[]) {
  return structuredClone(terms);
}

export interface ConfirmationGate {
  key: "version" | "terms" | "comments";
  passed: boolean;
  title: string;
  action: string;
  detail: string;
}

export function termInTranslation(sign: SignItem, term: TermBinding) {
  return sign.targetText.toLocaleLowerCase().includes(term.target.toLocaleLowerCase());
}

export function requiredTermGroups(sign: SignItem) {
  const required = sign.terms.filter((term) => term.required);
  const missing = required.filter((term) => !termInTranslation(sign, term));
  const unconfirmed = required.filter((term) => termInTranslation(sign, term) && !term.confirmed);
  return { required, missing, unconfirmed };
}

const formatTermNames = (terms: TermBinding[]) =>
  terms.map((term) => `「${term.source} → ${term.target}」`).join("、");

/** 确认前的三道门槛：保存过版本、必选术语入文并逐条确认、无未解决审校意见。 */
export function confirmationGates(sign: SignItem): ConfirmationGate[] {
  const { required, missing, unconfirmed } = requiredTermGroups(sign);
  const unresolved = sign.comments.filter((comment) => !comment.resolved);

  const termProblems: string[] = [];
  if (missing.length) termProblems.push(`未出现在译文中：${formatTermNames(missing)}`);
  if (unconfirmed.length) termProblems.push(`已入文但尚未逐条确认：${formatTermNames(unconfirmed)}`);

  return [
    {
      key: "version",
      passed: sign.versions.length > 0,
      title: "已保存过版本快照",
      action: "保存版本快照",
      detail: sign.versions.length > 0
        ? `最近快照：${sign.versions[0].label}（${new Date(sign.versions[0].createdAt).toLocaleString()}）`
        : "还没有保存过任何版本，请先在译文区点击“保存版本快照”。",
    },
    {
      key: "terms",
      passed: missing.length === 0 && unconfirmed.length === 0,
      title: "必选术语全部入文并逐条确认",
      action: "补全并逐条确认必选术语",
      detail: termProblems.length
        ? termProblems.join("；")
        : required.length
          ? `${required.length} 条必选术语均已出现在译文中并完成逐条确认。`
          : "未绑定必选术语，该门槛自动通过；建议为固定译法绑定术语。",
    },
    {
      key: "comments",
      passed: unresolved.length === 0,
      title: "审校意见没有未解决项",
      action: "解决全部未决审校意见",
      detail: unresolved.length
        ? `还有 ${unresolved.length} 条审校意见未解决，请逐条回复并标记“已解决”。`
        : sign.comments.length
          ? `${sign.comments.length} 条审校意见均已解决。`
          : "暂无审校意见。",
    },
  ];
}

export function canConfirm(sign: SignItem) {
  return !sign.emergencyRevision && confirmationGates(sign).every((gate) => gate.passed);
}

/** 左侧清单逐条列出的当前待处理步骤；已确认标识返回空列表。 */
export function pendingSteps(sign: SignItem): string[] {
  if (sign.status === "confirmed") return [];
  const steps: string[] = [];
  const { missing, unconfirmed } = requiredTermGroups(sign);
  const unresolved = sign.comments.filter((comment) => !comment.resolved).length;
  if (sign.versions.length === 0) steps.push("保存版本快照");
  if (missing.length) steps.push(`补入必选术语：${missing.map((term) => term.source).join("、")}`);
  if (unconfirmed.length) steps.push(`逐条确认术语（${unconfirmed.length} 条）`);
  if (unresolved) steps.push(`解决 ${unresolved} 条审校意见`);
  if (steps.length === 0) steps.push("点击“已确认”完成审校");
  return steps;
}

/** 读取历史数据时兜底：已确认但不满足门槛（含紧急修订）的标识退回待确认。 */
export function reconcileConfirmation(sign: SignItem) {
  if (sign.status === "confirmed" && !canConfirm(sign)) sign.status = "pending";
}
