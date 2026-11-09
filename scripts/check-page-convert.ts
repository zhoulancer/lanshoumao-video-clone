import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { convertMergedToH3, extractDialogueText } from "../lib/utils/dialogue";

const file = path.join(os.tmpdir(), "latest_analysis.txt");
const analysis = fs.readFileSync(file, "utf8");

const out = convertMergedToH3(analysis, { mode: "t2v" });
console.log("=== 用页面真实历史记录转换的结果 ===");
console.log(out);
console.log("\n长度:", out.length, "字 | 含 <d> 台词:", out.includes("<d>"));
console.log("解析到的台词:", JSON.stringify(extractDialogueText(analysis)));
