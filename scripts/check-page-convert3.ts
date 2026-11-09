import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { convertMergedToH3 } from "../lib/utils/dialogue";

const analysis = fs.readFileSync(path.join(os.tmpdir(), "latest_analysis.txt"), "utf8");
const out = convertMergedToH3(analysis); // 与页面一致：默认官方 I2V
console.log(out);
console.log("\n长度:", out.length, "字");
