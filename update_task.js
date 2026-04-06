const Database = require('better-sqlite3');
const db = new Database('/Users/john/private/ai/NanoClaw/store/messages.db');

const newPrompt = `你的任务是为 John 每天获取一篇 AI 领域的优质论文，进行翻译和解读。

## 1. 论文选择
- 优先选择近期高影响力的 AI 论文
- 来源：arXiv.org (CS.AI, CS.LG)、Papers with Code、顶级会议（NeurIPS、ICML、ICLR、ACL、CVPR）

## 2. 执行流程（必须严格按步骤，边处理边写文件）

### 第一步：下载并提取文本
使用 Bash 工具执行：
1. 用 curl 下载 PDF 到 /tmp/paper.pdf
2. 用 pdftotext -layout 提取文本到 /tmp/paper.txt
3. 用 wc -l /tmp/paper.txt 确认提取成功
4. 用 head -100 /tmp/paper.txt 查看开头，识别章节结构

### 第二步：立即创建输出文件
创建文件 /workspace/extra/md/John/personal/daily/YYYY-MM-DD-[论文英文短标题].md
写入论文基本信息：标题、作者、时间、会议/期刊、链接、引用数
然后追加翻译后的摘要（Abstract）

### 第三步：分章节翻译，每节翻译完立即追加写入文件
⚠️ 核心原则：每次只处理一个章节。读取该章节原文 → 翻译 → 立即用 Edit/Write 追加到文件 → 然后处理下一章节。绝对不要一次性翻译全文。

按顺序处理以下章节（每章独立处理）：
1. Introduction（引言）
2. Related Work（相关工作）—— 如有
3. Method / Approach（方法）
4. Experiments（实验）
5. Results & Analysis（结果与分析）
6. Conclusion（结论）
7. 参考文献 —— 仅列出10条最重要的引用，不全量翻译

提取某章节文本的方式：
- 用 grep -n "Introduction\|Method\|Experiment\|Conclusion" /tmp/paper.txt 找到各章节的行号
- 用 sed -n 'START,ENDp' /tmp/paper.txt 提取该章节内容
- 翻译后立即追加写入文件

### 第四步：写入费曼学习法解读
翻译全部完成后，追加以下解读内容（基于已保存的翻译，不需要重新读 PDF）：

- **核心概念**：用一段话解释这篇论文在做什么
- **解决的问题**：这个研究要解决什么痛点？
- **方法与原理**：作者用了什么方法？为什么有效？用一个日常类比来解释
- **实际应用场景**：这个研究可以用在哪里？
- **局限性与不足**：有哪些缺陷或未解决的问题？
- **对未来研究的启发**：这个工作对后续研究意味着什么？
- **重要术语**（5-10个关键术语及解释）
- **一句话总结**：这篇论文最核心的价值是什么

## 3. 完成后
向用户发送消息，包含：论文标题、原文链接、文件保存路径。`;

db.prepare('UPDATE scheduled_tasks SET prompt=? WHERE id=?').run(newPrompt, 'task-1772761230364-xi8j7a');
const updated = db.prepare('SELECT prompt FROM scheduled_tasks WHERE id=?').get('task-1772761230364-xi8j7a');
console.log('更新成功，新 prompt 长度：', updated.prompt.length);
