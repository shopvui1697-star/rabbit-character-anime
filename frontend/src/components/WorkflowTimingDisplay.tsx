"use client";

import React from "react";
import styles from "./WorkflowTimingDisplay.module.css";

interface WorkflowStep {
  step: string;
  name: string;
  nameJa: string;
  durationMs: number;
}

interface WorkflowTiming {
  steps: WorkflowStep[];
  hasDbSearch: boolean;
  dbSearchTime: number;
  usedTool: boolean;
  totalMs: number;
  timeToFirstResponse?: number;
  timeToFirstAudio?: number;
}

interface WorkflowTimingDisplayProps {
  timing: WorkflowTiming | null;
}

// Step icons
const STEP_ICONS: Record<string, string> = {
  STEP2_WEBSOCKET_SEND: "📡",
  STEP3_BACKEND_START: "⚡",
  STEP4_LLM_REQUEST: "🤖",
  STEP7_TEXT_RESPONSE: "📝",
  STEP8_TTS_SYNTHESIS: "🔊",
  STEP9_AUDIO_SEND: "📤",
  STEP11_TIMING_SEND: "⏱️",
  STEP12_COMPLETE: "✅",
};

// Step colors
const STEP_COLORS: Record<string, string> = {
  STEP2_WEBSOCKET_SEND: "#6366f1",
  STEP3_BACKEND_START: "#8b5cf6",
  STEP4_LLM_REQUEST: "#ec4899",
  STEP7_TEXT_RESPONSE: "#14b8a6",
  STEP8_TTS_SYNTHESIS: "#f59e0b",
  STEP9_AUDIO_SEND: "#10b981",
  STEP11_TIMING_SEND: "#64748b",
  STEP12_COMPLETE: "#22c55e",
};

function getTimingColor(ms: number): string {
  if (ms < 100) return "#10b981";
  if (ms < 300) return "#22c55e";
  if (ms < 800) return "#f59e0b";
  if (ms < 1500) return "#f97316";
  return "#ef4444";
}

function formatDuration(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function WorkflowTimingDisplay({ timing }: WorkflowTimingDisplayProps) {
  if (!timing || timing.steps.length === 0) {
    return null;
  }

  // Calculate cumulative time for waterfall
  let cumulativeTime = 0;
  const stepsWithCumulative = timing.steps.map((step) => {
    const startPercent = (cumulativeTime / timing.totalMs) * 100;
    const widthPercent = (step.durationMs / timing.totalMs) * 100;
    cumulativeTime += step.durationMs;
    return { ...step, startPercent, widthPercent };
  });

  const hasMetrics = timing.timeToFirstResponse !== undefined || timing.timeToFirstAudio !== undefined;

  return (
    <div className={styles.container}>
      {/* Key Metrics */}
      {hasMetrics && (
        <div className={styles.metrics}>
          {timing.timeToFirstResponse !== undefined && (
            <div className={styles.metric}>
              <span className={styles.metricIcon}>⚡</span>
              <div className={styles.metricContent}>
                <span className={styles.metricLabel}>TTFR</span>
                <span 
                  className={styles.metricValue}
                  style={{ color: getTimingColor(timing.timeToFirstResponse) }}
                >
                  {formatDuration(timing.timeToFirstResponse)}
                </span>
              </div>
            </div>
          )}
          {timing.timeToFirstAudio !== undefined && (
            <div className={styles.metric}>
              <span className={styles.metricIcon}>🔊</span>
              <div className={styles.metricContent}>
                <span className={styles.metricLabel}>TTFA</span>
                <span 
                  className={styles.metricValue}
                  style={{ color: getTimingColor(timing.timeToFirstAudio) }}
                >
                  {formatDuration(timing.timeToFirstAudio)}
                </span>
              </div>
            </div>
          )}
          <div className={styles.metric}>
            <span className={styles.metricIcon}>🏁</span>
            <div className={styles.metricContent}>
              <span className={styles.metricLabel}>Total</span>
              <span 
                className={styles.metricValue}
                style={{ color: getTimingColor(timing.totalMs) }}
              >
                {formatDuration(timing.totalMs)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Timeline */}
      <div className={styles.timeline}>
        <div className={styles.timelineTrack}>
          {stepsWithCumulative.map((step, index) => (
            <div
              key={index}
              className={styles.timelineBar}
              style={{
                left: `${step.startPercent}%`,
                width: `${Math.max(step.widthPercent, 2)}%`,
                backgroundColor: STEP_COLORS[step.step] || getTimingColor(step.durationMs),
              }}
              title={`${step.nameJa}: ${formatDuration(step.durationMs)}`}
            />
          ))}
        </div>
      </div>

      {/* Steps */}
      <div className={styles.steps}>
        {timing.steps.map((step, index) => {
          const percentage = timing.totalMs > 0
            ? ((step.durationMs / timing.totalMs) * 100).toFixed(0)
            : "0";
          const color = STEP_COLORS[step.step] || getTimingColor(step.durationMs);

          return (
            <div key={index} className={styles.step}>
              <span className={styles.stepIcon}>{STEP_ICONS[step.step] || "•"}</span>
              <span className={styles.stepName}>{step.nameJa}</span>
              <div className={styles.stepBar}>
                <div
                  className={styles.stepBarFill}
                  style={{
                    width: `${Math.min(parseFloat(percentage), 100)}%`,
                    backgroundColor: color,
                  }}
                />
              </div>
              <span className={styles.stepTime} style={{ color }}>
                {formatDuration(step.durationMs)}
              </span>
            </div>
          );
        })}
      </div>

      {/* Tool Info */}
      {timing.usedTool && timing.hasDbSearch && (
        <div className={styles.toolInfo}>
          <span>🔍 DB search: {formatDuration(timing.dbSearchTime)}</span>
        </div>
      )}
    </div>
  );
}
