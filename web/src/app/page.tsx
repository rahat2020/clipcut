import { Show } from "@clerk/nextjs";
import { ArrowRightIcon, CheckIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Logo } from "@/components/brand/logo";
import { HeroVisual, Silhouette } from "@/components/marketing/hero-visual";
import { buttonVariants } from "@/components/ui/button";
import { BRAND_NAME } from "@/lib/brand";
import { connectDb } from "@/lib/db";
import { ROUTES } from "@/lib/routes";
import { cn } from "@/lib/utils";
import { DEFAULT_PLAN, getSettings, retentionDaysForPlan } from "@/shared";

const STEPS = [
  { n: "01", title: "Drop in a long video", body: "Upload a file or paste a YouTube link. Talks, podcasts, classes and interviews work best." },
  { n: "02", title: "AI reads the whole thing", body: "The full transcript is read in one pass, so moments are ranked against the entire video — not chunk by chunk." },
  { n: "03", title: "Review, trim, post", body: "Every clip shows why it was picked. Approve, nudge the edges, and download 9:16 with captions burned in." },
];

const CAPTION_POINTS = ["Word-by-word highlight, timed to speech", "Three styles: Bold, Clean and Highlight", "Correct rendering for Bangla and English"];

const CAPTION_STYLES: { name: string; scene: string; text: string; active: string }[] = [
  { name: "Bold", scene: "#3e3228", text: "text-2xl font-extrabold [text-shadow:0_3px_0_#000,0_0_10px_rgba(0,0,0,0.9)]", active: "text-primary" },
  { name: "Clean", scene: "#2e3a36", text: "rounded-[10px] bg-background/75 px-2.5 py-2 text-[19px] font-semibold", active: "underline decoration-primary decoration-[3px] underline-offset-[5px]" },
  { name: "Highlight", scene: "#2f3242", text: "text-[22px] font-extrabold [text-shadow:0_2px_0_#000]", active: "rounded-md bg-primary px-1.5 text-primary-foreground [text-shadow:none]" },
];

const TRANSCRIPT: { t: string; text: string; picked: boolean }[] = [
  { t: "04:02.1", text: "Back then we spent weeks worrying about renting an office.", picked: false },
  { t: "04:12.3", text: "Everyone thinks money is the first thing you need to start a business.", picked: true },
  { t: "04:19.8", text: "But what you really need first is one customer who is willing to pay.", picked: true },
  { t: "04:31.0", text: "My first customer was a former colleague from my old office.", picked: true },
  { t: "04:58.9", text: "After that, we never looked back.", picked: true },
  { t: "05:04.2", text: "Okay, let’s move on to something else.", picked: false },
];

function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[13px] tracking-wide text-primary">{children}</span>;
}

function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn("font-heading text-4xl leading-[1.05] font-bold tracking-tight sm:text-5xl", className)}>{children}</h2>;
}

export default async function Home() {
  // Plan numbers come from the admin-editable settings, so the page never over-promises.
  await connectDb();
  const [limits, retention] = await Promise.all([getSettings("limits"), getSettings("retention")]);
  const free = limits.plans[DEFAULT_PLAN];
  const keepDays = retentionDaysForPlan(retention, DEFAULT_PLAN);

  const primaryCta = cn(buttonVariants({ size: "lg" }), "h-13 rounded-xl px-6 text-[17px]");

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-[72px] max-w-[1200px] items-center justify-between px-4 sm:px-8">
          <Logo />
          <nav aria-label="Sections" className="hidden items-center gap-9 text-[15px] text-muted-foreground md:flex">
            <a href="#how" className="hover:text-foreground">How it works</a>
            <a href="#captions" className="hover:text-foreground">Captions</a>
            <a href="#pricing" className="hover:text-foreground">Pricing</a>
          </nav>
          <div className="flex items-center gap-2">
            <Show when="signed-out">
              <Link href={ROUTES.signIn} className={buttonVariants({ variant: "ghost" })}>
                Sign in
              </Link>
              <Link href={ROUTES.signUp} className={buttonVariants()}>
                Start free
              </Link>
            </Show>
            <Show when="signed-in">
              <Link href={ROUTES.dashboard} className={buttonVariants()}>
                Open dashboard
              </Link>
            </Show>
          </div>
        </div>
      </header>

      <main className="flex flex-col">
        {/* Hero */}
        <section className="mx-auto flex w-full max-w-[1200px] items-center gap-16 px-4 pt-16 pb-20 sm:px-8 lg:pt-24">
          <div className="flex max-w-[560px] flex-col gap-7">
            <span className="flex h-8 w-fit items-center gap-2 rounded-full border bg-card px-3.5 text-sm text-foreground/80">
              <span className="size-[7px] rounded-full bg-primary" />
              Built for Bangla and English creators
            </span>
            <h1 className="font-heading text-5xl leading-none font-bold tracking-[-0.035em] text-balance sm:text-6xl lg:text-[76px]">
              One long video in. Shorts worth <span className="text-primary">posting</span> out.
            </h1>
            <p className="text-lg leading-relaxed text-pretty text-muted-foreground sm:text-[19px]">
              Upload a talk, podcast or class. We read the whole transcript, pick the moments with a real hook, and cut
              9:16 clips with word-by-word captions that render Bangla and English correctly.
            </p>
            <div className="flex flex-wrap items-center gap-3.5">
              <Link href={ROUTES.signUp} className={primaryCta}>
                Start free
                <ArrowRightIcon />
              </Link>
              <a href="#how" className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-13 rounded-xl px-5 text-[17px]")}>
                See how it works
              </a>
            </div>
            <p className="text-sm text-subtle">
              {free ? `${free.monthlyMinutes} free minutes every month · ` : ""}No card needed · Upload a file or paste a
              YouTube link
            </p>
          </div>
          <div className="hidden flex-1 justify-end lg:flex">
            <HeroVisual />
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="scroll-mt-20 border-t border-border/60">
          <div className="mx-auto flex max-w-[1200px] flex-col gap-12 px-4 py-20 sm:px-8 lg:py-24">
            <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
              <SectionTitle className="max-w-[620px]">From a 48-minute upload to a week of shorts.</SectionTitle>
              <p className="max-w-[420px] text-[17px] leading-relaxed text-muted-foreground">
                Three steps. The slow part runs in the background — close the tab and come back when your clips are ready.
              </p>
            </div>
            <ol className="grid gap-5 md:grid-cols-3">
              {STEPS.map((s) => (
                <li key={s.n} className="flex flex-col gap-4 rounded-2xl border bg-card p-8">
                  <span className="font-mono text-[13px] text-primary">{s.n}</span>
                  <h3 className="font-heading text-[26px] font-semibold tracking-tight">{s.title}</h3>
                  <p className="leading-relaxed text-muted-foreground">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Captions */}
        <section id="captions" className="scroll-mt-20 border-t border-border/60">
          <div className="mx-auto flex max-w-[1200px] flex-col gap-14 px-4 py-20 sm:px-8 lg:flex-row lg:items-center lg:py-24">
            <div className="flex flex-col gap-6 lg:w-[480px] lg:shrink-0">
              <Eyebrow>CAPTIONS</Eyebrow>
              <SectionTitle>Captions people actually read.</SectionTitle>
              <p className="text-[17px] leading-relaxed text-muted-foreground">
                Every word lights up as it’s spoken, sized for a phone held at arm’s length. Bangla is shaped the way it’s
                read, not drawn as loose letters.
              </p>
              <ul className="flex flex-col gap-3.5">
                {CAPTION_POINTS.map((p) => (
                  <li key={p} className="flex items-center gap-3">
                    <span className="flex size-6 items-center justify-center rounded-full bg-primary/15 text-primary">
                      <CheckIcon className="size-3.5" strokeWidth={2.6} />
                    </span>
                    {p}
                  </li>
                ))}
              </ul>
            </div>
            <div className="grid flex-1 grid-cols-3 gap-4" aria-hidden="true">
              {CAPTION_STYLES.map((c) => (
                <figure key={c.name} className="flex flex-col gap-3">
                  <div
                    className="relative aspect-[9/16] overflow-hidden rounded-[18px] border"
                    style={{ background: `radial-gradient(120% 90% at 50% 25%, ${c.scene} 0%, #141312 75%)` }}
                  >
                    <Silhouette />
                    <p className={cn("absolute inset-x-3 bottom-[22%] text-center leading-tight text-white", c.text)}>
                      Keep your goal <span className={c.active}>clear</span> and dream big
                    </p>
                  </div>
                  <figcaption className="text-sm text-muted-foreground">{c.name}</figcaption>
                </figure>
              ))}
            </div>
          </div>
        </section>

        {/* Clip selection */}
        <section className="border-t border-border/60">
          <div className="mx-auto flex max-w-[1200px] flex-col-reverse gap-14 px-4 py-20 sm:px-8 lg:flex-row lg:items-center lg:py-24">
            <div className="flex-1 overflow-hidden rounded-2xl border bg-card">
              <div className="flex h-12 items-center justify-between border-b px-5 text-[13px] text-subtle">
                <span>Transcript · podcast-ep12.mp4</span>
                <span className="font-mono">04:02 – 05:08</span>
              </div>
              <ol className="flex flex-col gap-0.5 p-2">
                {TRANSCRIPT.map((l) => (
                  <li
                    key={l.t}
                    className={cn("flex gap-3 rounded-[10px] px-3 py-2", l.picked ? "bg-primary/[0.12] text-foreground" : "text-subtle")}
                  >
                    <span className="w-16 shrink-0 pt-1 font-mono text-xs text-subtle">{l.t}</span>
                    <span className="text-[17px] leading-relaxed">{l.text}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="flex flex-col gap-6 lg:w-[460px] lg:shrink-0">
              <Eyebrow>CLIP SELECTION</Eyebrow>
              <SectionTitle>Picked the way an editor would.</SectionTitle>
              <p className="text-[17px] leading-relaxed text-muted-foreground">
                The whole transcript is read in one pass, so every moment is ranked against the entire video. Each clip
                starts and ends on a full sentence — never mid-word — and tells you why it was chosen.
              </p>
              <div className="flex flex-col gap-2.5 rounded-[14px] border bg-raised px-5 py-4">
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-subtle">Why this clip</span>
                  <span className="rounded-md bg-primary px-2 py-0.5 font-mono text-xs font-medium text-primary-foreground">94</span>
                </div>
                <p className="text-[15px] leading-relaxed">
                  Opens with a question the audience is already asking, answers it with a concrete example, and ends on a
                  complete thought.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="scroll-mt-20 border-t border-border/60">
          <div className="mx-auto flex max-w-[1200px] flex-col gap-10 px-4 py-20 sm:px-8 lg:py-24">
            <SectionTitle>Start free. Upgrade when you post daily.</SectionTitle>
            <div className="grid gap-5 md:grid-cols-2">
              <div className="flex flex-col gap-6 rounded-[18px] border border-primary bg-card p-9">
                <div className="flex items-baseline justify-between">
                  <h3 className="font-heading text-[28px] font-bold">Free</h3>
                  <span className="text-[15px] text-muted-foreground">No card needed</span>
                </div>
                {free && (
                  <ul className="flex flex-col gap-3 text-foreground/85">
                    <li>{free.monthlyMinutes} minutes of video every month</li>
                    <li>
                      Files up to {free.maxFileMB} MB, videos up to {free.maxDurationMin} minutes
                    </li>
                    <li>Up to {free.maxClipsPerVideo} clips per video</li>
                    <li>Clips and source kept for {keepDays} days</li>
                  </ul>
                )}
                <Link href={ROUTES.signUp} className={cn(buttonVariants({ size: "lg" }), "mt-auto w-full")}>
                  Start free
                </Link>
              </div>
              <div className="flex flex-col gap-6 rounded-[18px] border border-dashed border-line-strong bg-sunken p-9">
                <div className="flex items-baseline justify-between">
                  <h3 className="font-heading text-[28px] font-bold">Pro</h3>
                  <span className="text-[15px] text-subtle">Coming soon</span>
                </div>
                <p className="text-muted-foreground">For creators who post every day. Plan details are on the way.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Closing CTA */}
        <section className="mx-auto w-full max-w-[1200px] px-4 pb-20 sm:px-8">
          <div className="flex flex-col items-start justify-between gap-8 rounded-3xl border bg-card p-10 md:flex-row md:items-center md:p-16">
            <h2 className="max-w-[720px] font-heading text-4xl leading-[1.05] font-bold tracking-tight sm:text-[44px]">
              Your next ten shorts are already inside your last video.
            </h2>
            <Link href={ROUTES.signUp} className={cn(primaryCta, "shrink-0")}>
              Start free
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex h-24 max-w-[1200px] items-center justify-between px-4 text-sm text-subtle sm:px-8">
          <span>© {new Date().getFullYear()} {BRAND_NAME}</span>
        </div>
      </footer>
    </div>
  );
}
