import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  DatabaseZap,
  LoaderCircle,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { createDemoKnowledgeCandidate, publishDemoKnowledge } from "../api/demo";
import { getCapability, searchKnowledge } from "../api/client";
import { useOnboarding } from "../contexts/OnboardingContext";
import { Button, shortId } from "./ui";

const STEP_NAMES = ["连接节点", "导入知识", "审核发布", "引用检索", "Agent 接入"];
const DEMO_SPACE = "https://knowledge.local/spaces/demo-onboarding";

export function OnboardingWizard() {
  const onboarding = useOnboarding();
  const initial = useMemo(
    () => STEP_NAMES.findIndex((_, index) => !onboarding.completed.includes(index)),
    [onboarding.completed],
  );
  const [step, setStep] = useState(initial < 0 ? 4 : initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [nodeName, setNodeName] = useState<string>();
  const [resultCount, setResultCount] = useState<number>();
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!onboarding.isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const previousOverflow = document.body.style.overflow;
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onboarding.dismiss();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", dismissOnEscape);
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", dismissOnEscape);
      previousFocus?.focus();
    };
  }, [onboarding.isOpen]);
  if (!onboarding.isOpen) return null;

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (step === 0) {
        const capability = await getCapability();
        setNodeName(capability.node.name);
        onboarding.completeStep(0);
      }
      if (step === 1) {
        const candidate = onboarding.demo ?? await createDemoKnowledgeCandidate(DEMO_SPACE);
        onboarding.setDemo(candidate);
        onboarding.completeStep(1);
      }
      if (step === 2) {
        if (onboarding.demo === undefined) throw new Error("请先导入示例知识候选");
        const published = await publishDemoKnowledge(onboarding.demo);
        onboarding.setDemo(published);
        onboarding.completeStep(2);
      }
      if (step === 3) {
        const response = await searchKnowledge({
          query: "Agent 知识贡献检查清单",
          spaceId: DEMO_SPACE,
        });
        setResultCount(response.results.length);
        if (response.results.length === 0) throw new Error("没有找到示例知识，请先完成审核发布");
        onboarding.completeStep(3);
      }
      if (step === 4) onboarding.completeStep(4);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };
  const done = onboarding.completed.includes(step);
  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="onboarding-modal">
        <aside className="onboarding-rail">
          <div className="onboarding-brand"><Sparkles /><span><strong>KnowledgeOS</strong><small>5 分钟快速上手</small></span></div>
          <ol>{STEP_NAMES.map((name, index) => {
            const locked = index > 0 && !onboarding.completed.includes(index - 1) && !onboarding.completed.includes(index);
            return (
              <li className={index === step ? "active" : onboarding.completed.includes(index) ? "done" : locked ? "locked" : ""} key={name}>
                <button disabled={locked} onClick={() => setStep(index)}><span>{onboarding.completed.includes(index) ? <Check /> : index + 1}</span><b>{name}</b></button>
              </li>
            );
          })}</ol>
          <p>示例使用隔离的 demo-onboarding Space，可安全重置，不污染默认知识空间。</p>
          <button className="onboarding-reset" onClick={() => { onboarding.reset(); setStep(0); setError(undefined); }}><RotateCcw /> 重置引导</button>
        </aside>
        <section className="onboarding-stage">
          <button className="onboarding-close" aria-label="稍后继续" onClick={onboarding.dismiss} ref={closeButton}><X /></button>
          <div aria-label="新手引导完成进度" aria-valuemax={5} aria-valuemin={0} aria-valuenow={onboarding.completed.length} className="onboarding-progress" role="progressbar"><i style={{ width: `${(onboarding.completed.length / 5) * 100}%` }} /></div>
          <StepContent step={step} nodeName={nodeName} resultCount={resultCount} demo={onboarding.demo} />
          {error === undefined ? null : <div className="form-error" role="alert">{error}</div>}
          <div className="onboarding-actions">
            <Button disabled={step === 0 || busy} onClick={() => setStep((value) => value - 1)} variant="ghost"><ArrowLeft /> 上一步</Button>
            <span>{step + 1} / 5</span>
            {done ? step === 4 ? (
              <Button onClick={onboarding.finish}>完成引导 <Check /></Button>
            ) : (
              <Button onClick={() => setStep((value) => Math.min(value + 1, 4))}>下一步 <ArrowRight /></Button>
            ) : (
              <Button disabled={busy} onClick={() => void run()}>{busy ? <LoaderCircle className="spin" /> : stepIcon(step)} {busy ? "正在执行…" : actionLabel(step)}</Button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function StepContent({ step, nodeName, resultCount, demo }: {
  readonly step: number;
  readonly nodeName?: string;
  readonly resultCount?: number;
  readonly demo?: ReturnType<typeof useOnboarding>["demo"];
}) {
  const icons = [<DatabaseZap />, <Sparkles />, <ShieldCheck />, <Search />, <Bot />];
  const titles = ["连接你的第一个知识节点", "创建第一条知识候选", "用独立角色完成审核与发布", "执行一次带稳定引用的检索", "让 Agent 使用这份知识"];
  const descriptions = ["平台会读取标准能力文档，确认协议版本、Profile 与可用 Operations。", "示例内容会在浏览器生成 Payload Digest 与 Revision ID，然后提交到隔离演示 Space。", "服务端绑定实际 Schema 校验与安全扫描，Curator 和 Publisher 分别签发审核、策略证明。", "查询只从 Published Channel 返回结果，并附 Passage Citation、Revision 与策略义务。", "Agent 应先做能力发现、声明用途与支持的 obligations，并保留回答所用 Citation。"];
  return (
    <div className="onboarding-content">
      <span className={`onboarding-illustration illustration-${step}`}>{icons[step]}</span>
      <p className="eyebrow">STEP {step + 1}</p><h1 id="onboarding-title">{titles[step]}</h1><p>{descriptions[step]}</p>
      {step === 0 && nodeName !== undefined ? <OnboardingResult title={nodeName} detail="AKEP 0.1 · 能力发现成功" /> : null}
      {step === 1 && demo !== undefined ? <OnboardingResult title="候选已创建" detail={shortId(demo.revisionId, 44)} /> : null}
      {step === 2 && demo?.published === true ? <OnboardingResult title="校验、审核与发布完成" detail="知识已进入 Published Channel" /> : null}
      {step === 3 && resultCount !== undefined ? <OnboardingResult title={`找到 ${resultCount} 条结果`} detail="Query → Passage → Exposure Receipt → Citation" /> : null}
      {step === 4 ? <pre className="onboarding-code">{`import { AKEPClient } from "@akep/sdk";

const knowledge = new AKEPClient({
  baseUrl: "https://knowledge.example/akep/0.1",
  token: () => process.env.AKEP_TOKEN!,
  supportedObligations: ["cite", "no-train"],
});

const context = await knowledge.createContextPack({
  task: "生成带引用的退款处理步骤",
  purpose: "customer-support",
  budgetCharacters: 12_000,
});

console.log(context.contextDigest, context.passages);`}</pre> : null}
      <div className="learning-note"><strong>你会学到</strong><span>{step === 0 ? "不硬编码节点能力" : step === 1 ? "候选不等于已发布事实" : step === 2 ? "贡献、评测、审核、发布职责分离" : step === 3 ? "每次消费都有审计上下文" : "Agent 共享的是受治理知识，不是无边界记忆"}</span></div>
    </div>
  );
}

function OnboardingResult({ title, detail }: { readonly title: string; readonly detail: string }) {
  return <div className="onboarding-result"><CheckCircle2 /><span><strong>{title}</strong><small>{detail}</small></span></div>;
}

function actionLabel(step: number) {
  return ["测试连接", "创建示例候选", "生成评测并发布", "运行真实检索", "我已了解接入方式"][step];
}

function stepIcon(step: number) {
  return [<DatabaseZap key="db" />, <Sparkles key="spark" />, <ShieldCheck key="shield" />, <Search key="search" />, <Bot key="bot" />][step];
}
