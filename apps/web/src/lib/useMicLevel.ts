/**
 * Live microphone loudness, 0 to 1.
 *
 * The Web Speech API gives us words but no audio, so the orb's reaction to a voice needs a
 * second, read-only tap on the microphone: getUserMedia into an AnalyserNode, root-mean-
 * square of each frame.
 *
 * Nothing is recorded, uploaded or kept. The stream exists only while `active` is true and
 * every track is stopped the moment it is not, so the browser's recording indicator goes
 * out with the orb rather than lingering — on a product that lives in someone's home, a
 * microphone that stays lit after the conversation ends is its own kind of broken promise.
 */

import { useEffect, useRef, useState } from 'react';

/** Smoothing: enough that the orb breathes rather than flickers on every frame. */
const ATTACK = 0.35;
const RELEASE = 0.12;

export function useMicLevel(active: boolean): number {
  const [level, setLevel] = useState(0);
  const raf = useRef<number>(0);

  useEffect(() => {
    if (!active || !navigator.mediaDevices?.getUserMedia) {
      setLevel(0);
      return;
    }

    let cancelled = false;
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    let smoothed = 0;

    void navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((granted) => {
        // The user may have stopped listening while the permission prompt was open.
        if (cancelled) {
          granted.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = granted;

        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;

        context = new Ctor();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        // Our own smoothing below is gentler than the node's, applied to the RMS rather
        // than the spectrum.
        analyser.smoothingTimeConstant = 0;
        context.createMediaStreamSource(granted).connect(analyser);

        const buffer = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          analyser.getByteTimeDomainData(buffer);

          let sum = 0;
          for (const sample of buffer) {
            const centred = (sample - 128) / 128;
            sum += centred * centred;
          }
          const rms = Math.sqrt(sum / buffer.length);

          // Speech sits low in this range, so lift it into something visible without
          // letting a loud room peg the orb at full size.
          const scaled = Math.min(rms * 3.2, 1);
          smoothed += (scaled - smoothed) * (scaled > smoothed ? ATTACK : RELEASE);

          setLevel(smoothed);
          raf.current = requestAnimationFrame(tick);
        };

        raf.current = requestAnimationFrame(tick);
      })
      .catch(() => {
        // Denied, or no microphone. The orb simply sits still; speech recognition reports
        // its own error, and the buttons and the text field are unaffected.
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf.current);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => {});
      setLevel(0);
    };
  }, [active]);

  return level;
}
