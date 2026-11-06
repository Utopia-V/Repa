/**
 * 学习流程用到的数值集中在这里，每个都有名字和出处：Math Academy 公开（官网、Justin Skycak 的书与文章、采访），或 Repa 的假设。
 * 假设等实际使用和作答数据来校准；它们控制什么、什么证据会改变它们，见学习插件说明的“尚待查证的假设”。文档只引用这里的名字，
 * 不抄写数值。学生模型的常数在 @repa/learning-model 的 DEFAULT_MODEL_CONFIG，下面的 STUDENT_MODEL 是插件实际使用的那一组。
 */
import { DEFAULT_MODEL_CONFIG, type ModelConfig } from "@repa/learning-model";

/** 学习插件使用的学生模型参数。换一组参数重放同一份学习记录，就能比较两组参数的预测。 */
export const STUDENT_MODEL: ModelConfig = DEFAULT_MODEL_CONFIG;

// 课

// 课内的过关规则是 Repa 假设，见 flow-state.ts 的 lessonProgress：每个知识点的必做练习都要作答，答对的超过所答题数的
// 一半才通过，看比例而不看错题的个数。MA 按“连对两题”过关，前提是同一知识点的题池都是可以互换的同类变式（每个知识点约 20 题）；
// 现有课程的题池每题练的是不同方面、各只有一题，按连对两题过关会让学习者只做前两题，所以改为全做。
/**
 * 课或复习没通过以后的重试：学习者做完另一项任务，或者到了第二个本地自然日，就重新提供；菜单上没有别的任务可做时，
 * 休息 LESSON_REST_MS 后就重新提供，不让学习者干等。MA 公开：任务失败后先学不相关的 topic 再重试，重试前要等一段时间，等待期间学生可以在其他
 * 路线上继续推进，FAQ 说几天之内再次出现（The Math Academy Way 第 398 页等）；等待多久没有公开，休息时长是 Repa 假设。
 */
export const LESSON_REST_MS = 30 * 60_000;

// 复习

/** 一次复习最多出几题，出满仍没通过就失败。Repa 假设：MA 公开典型的复习有三到五题，完整的判定没有公开。 */
export const REVIEW_MAX_QUESTIONS = 5;
/** 复习通过至少要答对几题。Repa 假设。 */
export const REVIEW_PASS_CORRECT = 3;
/** 复习通过时，最后几题要连续答对。Repa 假设：MA 公开答对答错的先后影响判定，规则没有公开。复习不限时，与 MA 公开的一致。 */
export const REVIEW_FINAL_STREAK = 2;

// 交给学生模型的质量

/** 失败的质量是 1 减去答对的比例，但不低于它。Repa 假设：MA 公开表现越差、失败的负信用越大，计算式没有公开。 */
export const FAIL_QUALITY_FLOOR = 0.2;

// 菜单

/** 菜单最多列几项。Repa 假设：MA 的采访说菜单最多五项、通常更少。前端契约 LearningMenuSchema 的项数上限与它相同，改大时一起改。 */
export const MENU_SIZE = 3;
/** 连续做了几次复习以后，菜单先给一节合法的新课。MA 公开：The Math Academy Way 第 406 页，大约每三个复习插一节课。 */
export const REVIEWS_BEFORE_LESSON = 3;

// 测验

/** 课与复习的累计 XP 每到这个数，出现一场测验。MA 公开：官网 How It Works；2026 年的一次采访另说 120。 */
export const QUIZ_EVERY_XP = 150;
/** 测验出现以后，还能再挣多少 XP 才只剩测验可选。MA 公开：The Math Academy Way 第 467 页。 */
export const QUIZ_WINDOW_XP = 30;
/** 测验限时，从题目出现时算起。MA 公开的口述例子：2024 年 Chalk and Talk 采访里的 15 分钟测验。 */
export const QUIZ_DURATION_MS = 15 * 60_000;
/** 每场测验最多考几个 topic，每个一题。Repa 假设：MA 按预计用时决定题量。 */
export const QUIZ_TOPICS = 5;

// XP 与日目标（repa-xp-v1，Repa 假设；MA 公开 1 XP 约合一分钟专注学习，按表现奖惩，计算式没有公开）

/** 课或复习通过时至少给的 XP。课的满分是 topic 的预计用时（分钟），乘以答对的比例。 */
export const MIN_PASS_XP = 1;
/** 复习通过的满分，乘以答对的比例。 */
export const REVIEW_XP = 5;
/** 测验的满分，乘以答对的题数占全部交付题数的比例。 */
export const QUIZ_XP = 15;
/** 默认的每日 XP 目标。 */
export const DEFAULT_DAILY_GOAL_XP = 20;

// 完课估算

/** 每天平均的学习量取最近几个完整的本地自然日，没学的日子也算在内。Repa 假设。 */
export const ETA_WINDOW_DAYS = 7;
/** 这几天里至少有几天学过，才给出估算。Repa 假设。 */
export const ETA_MIN_ACTIVE_DAYS = 3;
