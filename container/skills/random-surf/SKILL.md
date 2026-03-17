---
name: random-surf
description: 自主探索调度器。检查是否到了探索时间，如果是则随机选择话题并输出 EXPLORE_NOW 信号。在定时探索任务中使用。
allowed-tools: Bash(random-surf)
---

# Random Surf 自主探索调度器

检查是否到了探索时间，到了则输出探索话题信号。

## 用法

```bash
random-surf
```

## 输出说明

**未到时间**：无输出，静默退出。

**到了时间**：
```
EXPLORE_NOW
大类:{随机选中的大类}
下次探索:{时间}（{分钟}分钟后）
```

## 大类

五个固定大类，每次随机选一个：
- 科技前沿
- 宇宙与自然
- 人文历史
- 社会与未来
- 科学与哲学

话题由 Claude 收到信号后实时检索决定，不预设。

## 调度策略

- 每次探索完成后随机等待 1-6 小时再做下一次
- 失败时 15 分钟后重试
- 调度状态保存在 `/workspace/group/discoveries/exploration_schedule.json`
