/**
 * Voice in and out.
 *
 * Out: Amazon Polly when the backend offers it, the browser's own speech synthesis when it
 * does not. In: the Web Speech API, with the on-screen buttons always present as the real
 * interface rather than a fallback — speech recognition fails on accents, in noise, and on
 * exactly the voices this product is for, so a design that depends on it would exclude the
 * people it is meant to serve.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// The Web Speech API is not in the DOM lib types, and is prefixed in Chromium.
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  results: {
    length: number;
    item(i: number): { isFinal: boolean; item(j: number): { transcript: string } };
    [i: number]: { isFinal: boolean; 0: { transcript: string } };
  };
}

type RecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export interface VoiceState {
  /** True while the microphone is open. */
  listening: boolean;
  /** True while audio is playing. */
  speaking: boolean;
  /** What the microphone has heard so far this turn. */
  interim: string;
  /** Undefined until we know; false means the buttons are the only input. */
  recognitionAvailable: boolean;
  /** Which voice is actually being used, shown in the UI so the demo is honest. */
  voiceSource: 'polly' | 'browser' | undefined;
  error: string | undefined;
  speak: (text: string) => Promise<void>;
  startListening: () => void;
  stopListening: () => void;
}

export function useVoice(options: {
  locale: string;
  onTranscript: (transcript: string) => void;
  muted: boolean;
}): VoiceState {
  const { locale, onTranscript, muted } = options;

  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState('');
  const [voiceSource, setVoiceSource] = useState<'polly' | 'browser'>();
  const [error, setError] = useState<string>();

  const recognition = useRef<SpeechRecognitionLike | undefined>(undefined);
  const audio = useRef<HTMLAudioElement | undefined>(undefined);
  // Held in a ref so the recognition handler, created once, always calls the latest one.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const recognitionAvailable = Boolean(getRecognitionCtor());

  // --- speaking ----------------------------------------------------------

  const speak = useCallback(
    async (text: string) => {
      if (muted || !text.trim()) return;

      // Stop whatever is already playing. Two voices talking over each other is worse
      // than a cut-off sentence, especially for someone hard of hearing.
      audio.current?.pause();
      window.speechSynthesis?.cancel();

      setSpeaking(true);
      try {
        const blob = await api.tts(text).catch(() => undefined);

        if (blob) {
          setVoiceSource('polly');
          const url = URL.createObjectURL(blob);
          const element = new Audio(url);
          audio.current = element;
          await new Promise<void>((resolve) => {
            element.onended = () => resolve();
            element.onerror = () => resolve();
            void element.play().catch(() => resolve());
          });
          URL.revokeObjectURL(url);
          return;
        }

        if (!window.speechSynthesis) {
          setError('This browser cannot speak aloud. The transcript is on screen.');
          return;
        }

        setVoiceSource('browser');
        await new Promise<void>((resolve) => {
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = locale;
          // Slightly slow, to match the pacing Polly is given server-side.
          utterance.rate = 0.95;

          // Belt and braces on the completion signal. Browser speech synthesis can fire
          // neither `onend` nor `onerror` — no voices installed, a headless browser, or
          // Chrome's known stalls — and a promise that never settles would leave
          // `speaking` true and the microphone button disabled forever. Roughly 14
          // characters a second, plus a floor, then give up and move on.
          const budgetMs = Math.min(30_000, 2_000 + (text.length / 14) * 1000);
          const timer = setTimeout(() => resolve(), budgetMs);
          const finish = () => {
            clearTimeout(timer);
            resolve();
          };

          utterance.onend = finish;
          utterance.onerror = finish;
          window.speechSynthesis.speak(utterance);
        });
      } finally {
        setSpeaking(false);
      }
    },
    [locale, muted],
  );

  // --- listening ---------------------------------------------------------

  const startListening = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setError('This browser cannot listen. Use the buttons below instead.');
      return;
    }

    // Never listen while speaking, or the agent transcribes itself.
    audio.current?.pause();
    window.speechSynthesis?.cancel();

    setError(undefined);
    setInterim('');

    const instance = new Ctor();
    instance.lang = locale;
    instance.interimResults = true;
    instance.continuous = false;
    instance.maxAlternatives = 1;

    instance.onresult = (event) => {
      let finalText = '';
      let pending = '';
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += text;
        else pending += text;
      }
      setInterim(pending || finalText);
      if (finalText.trim()) {
        setInterim('');
        onTranscriptRef.current(finalText.trim());
      }
    };

    instance.onerror = (event) => {
      setListening(false);
      setError(
        event.error === 'not-allowed'
          ? 'Microphone access is blocked. Use the buttons below instead.'
          : event.error === 'no-speech'
            ? "I didn't hear anything. Try again, or use the buttons below."
            : 'The microphone had a problem. Use the buttons below instead.',
      );
    };

    instance.onend = () => {
      setListening(false);
      setInterim('');
    };

    recognition.current = instance;
    try {
      instance.start();
      setListening(true);
    } catch {
      // Calling start() twice throws; treat it as already listening.
      setListening(true);
    }
  }, [locale]);

  const stopListening = useCallback(() => {
    recognition.current?.stop();
    setListening(false);
  }, []);

  useEffect(
    () => () => {
      recognition.current?.abort();
      audio.current?.pause();
      window.speechSynthesis?.cancel();
    },
    [],
  );

  return {
    listening,
    speaking,
    interim,
    recognitionAvailable,
    voiceSource,
    error,
    speak,
    startListening,
    stopListening,
  };
}
