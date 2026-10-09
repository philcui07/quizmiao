# 英语知识点出题质量对照

测试素材：用户提供的 8850 字“初中三年完整英语知识点清单”  
素材结构：22 个语法条目 + 10 个易混词/固定搭配，共 32 个明确知识点  
目标题数：20

## 产品 DeepSeek 线上实测

- 请求 20 题，约 60 秒后返回 14 题。
- 完全重复：第 2、14 题，均为 `Only by working hard ______ pass the exam.`。
- 合理去重后应保留约 13 题，不应只剩 6 题。
- 覆盖约 12 个知识点，集中在虚拟语气、倒装、There be 等少数条目。
- 约 10/14 题直接或轻微改写原文例句、易错题，场景迁移不足。
- 分类出现“语法”“词汇”等宽泛标签，不利于知识点覆盖控制。

DeepSeek 实际覆盖：

1. 过去虚拟语气
2. Only 倒装
3. 感官动词主动表被动
4. look forward to doing
5. -ed/-ing 形容词
6. spend/take/cost/pay
7. if 主将从现
8. 现在虚拟语气
9. try doing
10. There be 就近原则（复数）
11. did 后动词原形
12. There be 就近原则（单数）
13. by the time 时态
14. Only 倒装（与第 2 题重复）

## GPT 对照组

GPT 按“每题优先来自不同编号知识点、使用新场景、具体分类名”生成 20 题。20 题无重复，覆盖 20 个知识点：

| # | 具体知识点 | 题干摘要 | 正确答案 |
|---|---|---|---|
| 1 | 一般现在时三单 | Every Sunday, Lucy ___ her grandparents. | visits |
| 2 | 现在进行时表将来 | We ___ for Shanghai tomorrow; the tickets are ready. | are leaving |
| 3 | did 后动词还原 | Why did Ben ___ the meeting early? | leave |
| 4 | have gone to / been to | Jack is not here. He ___ the library. | has gone to |
| 5 | 感官动词无被动 | The soup ___ delicious after adding tomatoes. | tastes |
| 6 | make 被动加 to | The players were made ___ for another hour. | to practise |
| 7 | stop to do / doing | After driving for two hours, Dad stopped ___ a rest. | to have |
| 8 | It is of/for sb. | It was careless ___ him to leave the door open. | of |
| 9 | as...as 原级 | This route is not as ___ as the mountain road. | dangerous |
| 10 | -ed/-ing 形容词 | The result was ___, and everyone felt ___. | surprising; surprised |
| 11 | There be 就近原则 | There ___ a teacher and thirty students in the room. | is |
| 12 | must 否定回答 | —Must we hand it in today? —No, you ___. | needn't |
| 13 | if 主将从现 | If Mia ___ regularly, she will improve quickly. | practises |
| 14 | 宾语从句陈述语序 | Could you tell me where ___? | the post office is |
| 15 | too much / much too | The bag is ___ heavy because it contains ___ food. | much too; too much |
| 16 | affect / effect | Noise can ___ sleep and have a bad ___ on health. | affect; effect |
| 17 | spend/take/cost/pay | The new dictionary ___ me 80 yuan. | cost |
| 18 | look forward to doing | We look forward to ___ from you soon. | hearing |
| 19 | across / through | The boy ran ___ the field and then walked ___ the tunnel. | across; through |
| 20 | rise / raise | Prices may ___, so the company plans to ___ salaries. | rise; raise |

## 结论

差距主要不是 DeepSeek 不认识这些知识点，而是流程约束：

1. 单次生成缺少先覆盖编号条目的规划，模型会反复选择最显眼的例句。
2. 原查重接口返回“保留编号”，遗漏编号会被系统当成删除，造成 20 题只剩 6 题。
3. 原分批按字符位置切割，可能把同一个知识点的定义、例句和错因拆散。
4. 原提示词允许不足目标数量，并缺少具体分类名和新场景要求。

修复后改为：编号条目完整分批、30 个候选、具体知识点分类、新场景优先、查重只返回重复组、默认保留全部未举证题目，并限制语义去重最多只删除 10 个冗余候选。
