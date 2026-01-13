
import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  analyser?: AnalyserNode;
  active: boolean;
}

const Visualizer: React.FC<VisualizerProps> = ({ analyser, active }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Fixed: useRef expects 1 argument (initial value). 
  // Line 11 error fix: providing undefined as initial value.
  const animationRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!active || !analyser || !canvasRef.current) {
      if (canvasRef.current) {
        const ctx = canvasRef.current.getContext('2d');
        ctx?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      }
      return;
    }

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.fillStyle = 'rgba(26, 26, 26, 0.5)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2.5;
      let barHeight;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        barHeight = (dataArray[i] / 255) * canvas.height;

        ctx.fillStyle = `rgb(16, 185, 129)`; // Emerald-500
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);

        x += barWidth + 1;
      }
    };

    draw();

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [active, analyser]);

  return (
    <div className="bg-[#0f0f0f] border border-zinc-800 rounded-lg h-24 w-full relative overflow-hidden flex items-end px-2 py-2">
      <canvas
        ref={canvasRef}
        width={400}
        height={100}
        className="w-full h-full object-cover"
      />
    </div>
  );
};

export default Visualizer;
