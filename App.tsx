
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { AppMode, ConnectionStatus, TranscriptionSegment } from './types';
import { LANGUAGES } from './constants';
import { broadcastTranscription, subscribeToTranscription } from './services/supabaseService';
import { createBlob, decode, decodeAudioData } from './services/audioUtils';
import Visualizer from './components/Visualizer';

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>('SOURCE');
  const [classId, setClassId] = useState<string>('SUCCESS-01');
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.IDLE);
  const [transcriptions, setTranscriptions] = useState<TranscriptionSegment[]>([]);
  const [targetLanguage, setTargetLanguage] = useState('nl-BE'); // Default target
  const [isSpeaking, setIsSpeaking] = useState(false);
  
  // Refs for Gemini session & Audio
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Accumulator for real-time text chunks
  const currentChunkRef = useRef('');

  // Auto-scroll transcriptions
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  }, [transcriptions]);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(classId);
  };

  const startBroadcasting = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      // Create a new instance right before use
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = audioContextRef.current.createMediaStreamSource(stream);
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 128;
      source.connect(analyserRef.current);

      const scriptProcessor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              const volume = Math.sqrt(sum / inputData.length);
              setIsSpeaking(volume > 0.01);

              const pcmBlob = createBlob(inputData);
              // CRITICAL: Solely rely on sessionPromise resolves and then call sendRealtimeInput
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Process model's output audio bytes
            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const audioSource = ctx.createBufferSource();
              audioSource.buffer = buffer;
              audioSource.connect(ctx.destination);
              
              audioSource.addEventListener('ended', () => {
                sourcesRef.current.delete(audioSource);
              });

              audioSource.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(audioSource);
            }

            // Handle model interruption
            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const s of sourcesRef.current.values()) {
                try { s.stop(); } catch(e) {}
                sourcesRef.current.delete(s);
              }
              nextStartTimeRef.current = 0;
            }

            // Handle input transcription
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              currentChunkRef.current += text;
              
              const segment: TranscriptionSegment = {
                id: 'live-seg',
                text: currentChunkRef.current,
                timestamp: Date.now(),
                speaker: 'user',
                isFinal: false,
                classId
              };

              setTranscriptions(prev => {
                const filtered = prev.filter(p => p.id !== 'live-seg');
                return [...filtered, segment];
              });

              broadcastTranscription(classId, segment);
            }

            // Handle turn completion
            if (message.serverContent?.turnComplete) {
              const finalId = `final-${Date.now()}`;
              const finalSegment: TranscriptionSegment = {
                id: finalId,
                text: currentChunkRef.current,
                timestamp: Date.now(),
                speaker: 'user',
                isFinal: true,
                classId
              };

              setTranscriptions(prev => {
                const filtered = prev.filter(p => p.id !== 'live-seg');
                return [...filtered, finalSegment];
              });

              broadcastTranscription(classId, finalSegment);
              currentChunkRef.current = '';
            }
          },
          onerror: (e) => {
            console.error('Gemini error:', e);
            setStatus(ConnectionStatus.ERROR);
          },
          onclose: () => {
            setStatus(ConnectionStatus.IDLE);
            setIsSpeaking(false);
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          systemInstruction: `You are a professional classroom transcriber and translator for "${classId}". 
          Your primary task is to transcribe speech. 
          Additionally, provide a translation to ${LANGUAGES.find(l => l.code === targetLanguage)?.name || 'Dutch'} after the transcription of each significant sentence. 
          Format: "[Original] | [Translation]".`,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          }
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error('Broadcast failure:', err);
      setStatus(ConnectionStatus.ERROR);
    }
  };

  const stopBroadcasting = () => {
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    setStatus(ConnectionStatus.IDLE);
    setTranscriptions([]);
    setIsSpeaking(false);
  };

  useEffect(() => {
    if (mode === 'RECEIVER') {
      const unsubscribe = subscribeToTranscription(classId, (segment) => {
        setTranscriptions(prev => {
          const filtered = prev.filter(s => s.id !== segment.id && (segment.isFinal || s.id !== 'live-seg'));
          const updated = [...filtered, segment];
          return updated.slice(-50);
        });
      });
      return unsubscribe;
    }
  }, [mode, classId]);

  return (
    <div className="flex flex-col h-screen max-w-md mx-auto bg-black text-white font-sans overflow-hidden">
      <div className={`absolute inset-0 transition-opacity duration-1000 pointer-events-none opacity-10 ${isSpeaking ? 'bg-orange-500/20' : 'bg-transparent'}`} 
           style={{ filter: 'blur(120px)' }} />

      <header className="px-6 pt-10 pb-4 z-10">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-black tracking-tighter text-white uppercase italic">Success Class</h1>
            <p className="text-orange-500 font-bold text-[10px] tracking-[0.2em] uppercase">Cloud Audio Intel</p>
          </div>
          <div className="flex items-center bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-full px-3 py-1 shadow-xl">
             <div className={`w-2 h-2 rounded-full mr-2 transition-all duration-300 ${status === ConnectionStatus.CONNECTED ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : 'bg-zinc-700'}`} />
             <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-tighter">{status}</span>
          </div>
        </div>
        
        <div className="mt-6 flex gap-2">
          <div className="flex-1 p-3 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-2xl flex flex-col group transition-all">
            <span className="text-zinc-500 text-[8px] font-bold uppercase tracking-widest mb-1">Class Channel</span>
            <input 
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              disabled={status === ConnectionStatus.CONNECTED}
              className="bg-transparent border-none p-0 text-lg font-mono font-bold focus:ring-0 text-white w-full uppercase"
            />
          </div>
          <div className="w-1/3 p-3 bg-zinc-900/80 backdrop-blur border border-zinc-800 rounded-2xl flex flex-col transition-all">
            <span className="text-zinc-500 text-[8px] font-bold uppercase tracking-widest mb-1">Translate To</span>
            <select
              value={targetLanguage}
              onChange={(e) => setTargetLanguage(e.target.value)}
              disabled={status === ConnectionStatus.CONNECTED}
              className="bg-transparent border-none p-0 text-xs font-bold focus:ring-0 text-orange-500 w-full appearance-none"
            >
              {LANGUAGES.map(l => (
                <option key={l.code} value={l.code} className="bg-zinc-900 text-white">{l.name.split(' ')[0]}</option>
              ))}
            </select>
          </div>
        </div>
      </header>

      <div className="px-6 py-2 z-10">
        <div className="flex p-1 bg-zinc-900/50 backdrop-blur rounded-xl border border-zinc-800">
          <button
            onClick={() => { setMode('SOURCE'); setTranscriptions([]); }}
            className={`flex-1 py-2 text-[10px] font-black uppercase tracking-[0.2em] rounded-lg transition-all ${mode === 'SOURCE' ? 'bg-orange-600 text-white shadow-lg shadow-orange-900/20' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            Broadcast
          </button>
          <button
            onClick={() => { setMode('RECEIVER'); setTranscriptions([]); }}
            className={`flex-1 py-2 text-[10px] font-black uppercase tracking-[0.2em] rounded-lg transition-all ${mode === 'RECEIVER' ? 'bg-orange-600 text-white shadow-lg shadow-orange-900/20' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            Receiver
          </button>
        </div>
      </div>

      <main className="flex-1 overflow-hidden flex flex-col p-6 z-10">
        <div className={`flex-1 bg-zinc-900/20 border-2 rounded-[2.5rem] flex flex-col relative overflow-hidden backdrop-blur-md transition-all duration-700 ${isSpeaking ? 'border-orange-500/40 shadow-[0_0_40px_rgba(249,115,22,0.1)] scale-[1.005]' : 'border-zinc-800/50'}`}>
          
          <div className="absolute top-0 left-0 right-0 p-6 flex justify-between items-center z-20 bg-gradient-to-b from-black/60 to-transparent pointer-events-none">
            <span className="text-[8px] font-black text-zinc-500 uppercase tracking-[0.2em]">{mode === 'SOURCE' ? 'Live Capture' : 'Network Stream'}</span>
            <div className="flex gap-2">
              {isSpeaking && (
                <div className="flex items-center bg-orange-500/20 border border-orange-500/40 px-3 py-1 rounded-full animate-pulse transition-all">
                  <span className="text-[8px] font-black text-orange-500 tracking-widest uppercase">Capturing Audio...</span>
                </div>
              )}
            </div>
          </div>

          {/* The transcription feed container with refined mask */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-8 space-y-10 pt-24 pb-20 scrollbar-hide transcription-gradient-mask">
            {transcriptions.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center opacity-40">
                <div className="relative">
                   <div className={`w-20 h-20 border-2 border-zinc-800 rounded-full flex items-center justify-center transition-all duration-500 ${status === ConnectionStatus.CONNECTED ? 'border-orange-500/50 scale-110 shadow-[0_0_20px_rgba(249,115,22,0.1)]' : ''}`}>
                      <svg xmlns="http://www.w3.org/2000/svg" className={`h-8 w-8 transition-colors ${status === ConnectionStatus.CONNECTED ? 'text-orange-500' : 'text-zinc-700'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                   </div>
                </div>
                <p className="mt-6 text-[10px] font-bold tracking-[0.3em] uppercase text-zinc-600 text-center px-10 leading-relaxed">
                  {mode === 'SOURCE' ? 'System ready for broadcast initialization.' : 'Waiting for incoming class signal.'}
                </p>
              </div>
            ) : (
              transcriptions.map((s, idx) => {
                const parts = s.text.split('|');
                const hasTranslation = parts.length > 1;
                
                return (
                  <div key={s.id + idx} className={`animate-segment-pop group`}>
                     <div className="space-y-4">
                        <p className={`text-2xl font-bold leading-snug transition-all duration-500 ${s.isFinal ? 'text-zinc-100' : 'text-orange-500/80 animate-pulse'}`}>
                          {parts[0].trim()}
                        </p>
                        {hasTranslation && (
                           <div className="flex gap-4 items-start animate-in zoom-in-95 duration-700 delay-300">
                             <div className="mt-2.5 h-px w-8 bg-emerald-500/40 shrink-0" />
                             <p className="text-lg font-medium text-emerald-400 italic leading-relaxed opacity-90 drop-shadow-[0_0_10px_rgba(52,211,153,0.1)]">
                               {parts[1].trim()}
                             </p>
                           </div>
                        )}
                     </div>
                  </div>
                );
              })
            )}
            {/* Scroll anchor / buffer area */}
            <div className="h-12 w-full" />
          </div>

          {mode === 'SOURCE' && (
            <div className="px-6 pb-6 mt-auto">
               <div className="rounded-[2.2rem] overflow-hidden border border-zinc-800/40 shadow-2xl transition-all duration-500 hover:border-zinc-700/60">
                 <Visualizer active={status === ConnectionStatus.CONNECTED} analyser={analyserRef.current || undefined} />
               </div>
            </div>
          )}
        </div>
      </main>

      <footer className="px-10 pb-12 pt-4 z-10">
        {mode === 'SOURCE' ? (
          status === ConnectionStatus.CONNECTED ? (
            <button
              onClick={stopBroadcasting}
              className="group relative w-full h-16 rounded-3xl overflow-hidden active:scale-95 transition-all"
            >
              <div className="absolute inset-0 bg-zinc-900 border-2 border-zinc-800 group-hover:bg-zinc-800 transition-colors" />
              <span className="relative z-10 text-[11px] font-black uppercase tracking-[0.4em] text-white">Stop Broadcast</span>
            </button>
          ) : (
            <button
              onClick={startBroadcasting}
              disabled={status === ConnectionStatus.CONNECTING}
              className="group relative w-full h-16 rounded-3xl overflow-hidden active:scale-95 transition-all disabled:opacity-50"
            >
              <div className="absolute inset-0 bg-orange-600 group-hover:bg-orange-500 transition-colors shadow-[0_20px_40px_rgba(234,88,12,0.25)]" />
              <span className="relative z-10 flex items-center justify-center gap-4 text-[11px] font-black uppercase tracking-[0.4em] text-white">
                {status === ConnectionStatus.CONNECTING ? (
                  <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                ) : null}
                {status === ConnectionStatus.CONNECTING ? 'Syncing...' : 'Begin Stream'}
              </span>
            </button>
          )
        ) : (
           <div className="h-16 flex items-center justify-between bg-zinc-900/40 backdrop-blur-2xl border border-zinc-800/60 px-6 rounded-3xl shadow-lg">
              <div className="flex flex-col">
                <span className="text-[8px] font-black text-zinc-500 uppercase tracking-widest mb-0.5">Socket Engine</span>
                <span className="text-[10px] font-black text-white uppercase tracking-tight">Cloud Sync Active</span>
              </div>
              <div className="flex gap-1.5 h-4 items-center">
                {[1,2,3].map(i => (
                  <div key={i} className={`w-1 rounded-full bg-orange-500/60 animate-bounce`} 
                       style={{ 
                         animationDelay: `${i * 0.15}s`, 
                         height: i === 2 ? '100%' : '60%',
                         animationDuration: '0.6s'
                       }} />
                ))}
              </div>
           </div>
        )}
      </footer>
    </div>
  );
};

export default App;
