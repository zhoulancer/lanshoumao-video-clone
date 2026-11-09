import { buildH3Prompt, convertMergedToH3, formatDialogueWithTiming } from "../lib/utils/dialogue";

const analysis = `【画面深度描述】
一名中年亚洲男子在白色瓷砖墙的室内空间对着手机自拍，神情生动、口型张开。

═══════════════════════════════════════════════════════════════
【AI视频生成提示词】

📌 核心提示词：
竖屏自拍视角，亚洲中年男子在白色瓷砖室内变装表演，从黑色卫衣切换为红蓝缎面清朝官服戴官帽假辫，拇指戴绿色翡翠扳指比划手势，说话口型生动，室内顶光，写实短视频质感，9:16

🔧 技术参数建议：
• 宽高比：9:16`;

const segments = [
  { start: 0, end: 4, text: "你戒色不是把你手机里的老师们删掉就行了" },
  { start: 4, end: 6.7, text: "你得除掉根" },
  { start: 6.7, end: 8.1, text: "俗话说" },
  { start: 8.1, end: 10.8, text: "斩草除根" },
];

const dialogue = formatDialogueWithTiming(segments);
const merged = `${analysis}\n\n【台词】\n${dialogue}`;

console.log("========== I2V 官方格式 ==========");
console.log(buildH3Prompt(analysis, "你戒色不是把你手机里的老师们删掉就行了"));

console.log("\n========== 从合并文本自动转换 ==========");
console.log(convertMergedToH3(merged));

console.log("\n========== T2V 模式（无首帧行） ==========");
console.log(convertMergedToH3(merged, { mode: "t2v" }));
