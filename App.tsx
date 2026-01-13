
import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { AppMode, ConnectionStatus, TranscriptionSegment } from './types';
import { LANGUAGES } from './constants';
import { broadcastTranscription, subscribeToTranscription } from './services/supabaseService';
import { createBlob, decode, decodeAudioData } from './services/audioUtils';
import Visualizer from './components/Visualizer';

const App: React.FC = () => {
  const [mode, setMode] = useState<AppMode>('SOURCE');
  const [classId, setClassId] = useState<string>('CLASS-' + Math.floor(1000 + Math.random() * 9000));
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.IDLE);
  const [transcriptions, setTranscriptions] = useState<TranscriptionSegment[]>([]);
  const [targetLanguage, setTargetLanguage] = useState('nl-BE'); 
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isProcessingTTS, setIsProcessingTTS] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [quotaWait, setQuotaWait] = useState<number>(0);
  
  const sessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const currentChunkRef = useRef('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const ttsQueueRef = useRef<string[]>([]);

  const isHost = mode === 'SOURCE';

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
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  const handleClassIdChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    setClassId(value);
  };

  const startBroadcasting = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
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
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
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
          systemInstruction: `You are the Host of the class session "${classId}". 
          Your role is to capture audio and provide a live, highly accurate transcription of the lecture.
          Auto-detect the language spoken. Output ONLY the raw transcription chunks via the audio transcription channel.`,
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
    setStatus(ConnectionStatus.IDLE);
    setTranscriptions([]);
    setIsSpeaking(false);
  };

  const handleIncomingSegment = async (segment: TranscriptionSegment) => {
    setTranscriptions(prev => {
      const filtered = prev.filter(s => s.id !== segment.id && (segment.isFinal || s.id !== 'live-seg'));
      const updated = [...filtered, segment];
      return updated.slice(-50);
    });

    if (segment.isFinal && segment.text.trim()) {
      processTranslationAndSpeech(segment.text);
    }
  };

  const processTranslationAndSpeech = async (originalText: string, retryCount = 0) => {
    if (isProcessingTTS && retryCount === 0) {
      ttsQueueRef.current.push(originalText);
      return;
    }

    setIsProcessingTTS(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const targetLangObj = LANGUAGES.find(l => l.code === targetLanguage);
      const langName = targetLangObj?.name || targetLanguage;

      if (!outputAudioContextRef.current) {
        outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }
      
      const ttsResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: `Translate precisely and then speak ONLY the translated text in ${langName}: ${originalText}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });

      const audioData = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (audioData) {
        const ctx = outputAudioContextRef.current;
        nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
        const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
        const audioSource = ctx.createBufferSource();
        audioSource.buffer = buffer;
        audioSource.connect(ctx.destination);
        audioSource.addEventListener('ended', () => {
          sourcesRef.current.delete(audioSource);
          checkQueue();
        });
        audioSource.start(nextStartTimeRef.current);
        nextStartTimeRef.current += buffer.duration;
        sourcesRef.current.add(audioSource);
      } else {
        checkQueue();
      }
    } catch (err: any) {
      console.error('TTS/Translation failed:', err);
      if (err?.message?.includes('429') || err?.status === 'RESOURCE_EXHAUSTED') {
        const waitTime = 10000;
        setQuotaWait(waitTime / 1000);
        const timer = setInterval(() => setQuotaWait(p => Math.max(0, p - 1)), 1000);
        setTimeout(() => {
          clearInterval(timer);
          setQuotaWait(0);
          processTranslationAndSpeech(originalText, retryCount + 1);
        }, waitTime);
      } else {
        checkQueue();
      }
    } finally {
      setIsProcessingTTS(false);
    }
  };

  const checkQueue = () => {
    if (ttsQueueRef.current.length > 0) {
      const next = ttsQueueRef.current.shift();
      if (next) processTranslationAndSpeech(next);
    }
  };

  useEffect(() => {
    if (mode === 'RECEIVER') {
      const unsubscribe = subscribeToTranscription(classId, handleIncomingSegment);
      return unsubscribe;
    } else {
      setTranscriptions([]);
    }
  }, [mode, classId, targetLanguage]);

  return (
    <div className="flex flex-col h-screen max-w-md mx-auto bg-black text-white font-sans overflow-hidden transition-colors duration-1000">
      {/* Background Aura specialized by Role */}
      <div className={`absolute inset-0 transition-opacity duration-1000 pointer-events-none opacity-20 ${isHost ? 'bg-orange-600/10' : 'bg-blue-600/10'}`} 
           style={{ filter: 'blur(120px)' }} />
      {isSpeaking && isHost && (
        <div className="absolute top-0 left-0 right-0 h-1 bg-orange-500 shadow-[0_0_15px_#f97316] z-50 animate-pulse" />
      )}

      <header className="px-6 pt-10 pb-4 z-20">
        <div className="flex justify-between items-start">
          <div className="flex flex-col">
            <h1 className="text-3xl font-black tracking-tighter text-white uppercase italic leading-none">Success Class</h1>
            <div className="flex items-center gap-2 mt-2">
              <span className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all duration-500 border ${isHost ? 'bg-orange-600/20 text-orange-400 border-orange-500/30' : 'bg-blue-600/20 text-blue-400 border-blue-500/30'}`}>
                <div className={`w-1.5 h-1.5 rounded-full animate-pulse ${isHost ? 'bg-orange-500' : 'bg-blue-500'}`} />
                {isHost ? 'Host Command' : 'Participant View'}
              </span>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
             <div className="flex items-center bg-zinc-900/90 backdrop-blur border border-zinc-800 rounded-full px-3 py-1.5 shadow-2xl">
               <div className={`w-2 h-2 rounded-full mr-2 transition-all duration-300 ${status === ConnectionStatus.CONNECTED ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' : (mode === 'RECEIVER' ? 'bg-blue-500' : 'bg-zinc-700')}`} />
               <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-tighter">
                  {status === ConnectionStatus.CONNECTED ? 'LIVE' : status}
               </span>
             </div>
          </div>
        </div>
        
        <div className="mt-6 flex gap-2">
          <div className={`flex-1 p-3 bg-zinc-900/80 backdrop-blur border rounded-2xl flex flex-col group transition-all duration-500 ${isHost ? 'border-zinc-800' : 'border-blue-900/30'}`}>
            <span className="text-zinc-500 text-[8px] font-bold uppercase tracking-widest mb-1">
              {isHost ? 'Your Session ID' : 'Target Session ID'}
            </span>
            <div className="flex items-center justify-between">
              <input 
                value={classId}
                onChange={handleClassIdChange}
                placeholder="CHANNEL-ID"
                disabled={status === ConnectionStatus.CONNECTED}
                className={`bg-transparent border-none p-0 text-xl font-mono font-black focus:ring-0 w-full uppercase placeholder:text-zinc-800 transition-colors ${!isHost ? 'text-blue-100' : 'text-white'}`}
              />
              <button onClick={copyToClipboard} className={`transition-all ${copyFeedback ? 'text-emerald-500 scale-110' : (isHost ? 'text-zinc-600 hover:text-orange-500' : 'text-zinc-600 hover:text-blue-500')}`}>
                {copyFeedback ? (
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {!isHost && (
            <div className="w-1/3 p-3 bg-zinc-900/80 backdrop-blur border border-blue-900/40 rounded-2xl flex flex-col transition-all">
              <span className="text-blue-500/60 text-[8px] font-bold uppercase tracking-widest mb-1 truncate">Translate To</span>
              <select
                value={targetLanguage}
                onChange={(e) => setTargetLanguage(e.target.value)}
                className="bg-transparent border-none p-0 text-xs font-bold focus:ring-0 text-blue-400 w-full appearance-none overflow-hidden text-ellipsis cursor-pointer"
              >
                {LANGUAGES.map(l => (
                  <option key={l.code} value={l.code} className="bg-zinc-900 text-white">{l.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </header>

      <div className="px-6 py-2 z-20">
        <div className="flex p-1 bg-zinc-900/50 backdrop-blur rounded-xl border border-zinc-800 shadow-lg relative">
          <button
            onClick={() => { setMode('SOURCE'); stopBroadcasting(); }}
            className={`flex-1 py-2.5 text-[10px] font-black uppercase tracking-[0.2em] rounded-lg transition-all duration-300 z-10 ${isHost ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            Host Role
          </button>
          <button
            onClick={() => { setMode('RECEIVER'); stopBroadcasting(); }}
            className={`flex-1 py-2.5 text-[10px] font-black uppercase tracking-[0.2em] rounded-lg transition-all duration-300 z-10 ${!isHost ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            Participant Role
          </button>
          <div className={`absolute top-1 bottom-1 left-1 w-[calc(50%-4px)] transition-all duration-500 ease-out rounded-lg shadow-xl ${isHost ? 'bg-orange-600 translate-x-0' : 'bg-blue-600 translate-x-full'}`} />
        </div>
      </div>

      <main className="flex-1 overflow-hidden flex flex-col p-6 z-10">
        <div className={`flex-1 bg-zinc-950/40 border-2 rounded-[2.5rem] flex flex-col relative overflow-hidden backdrop-blur-md transition-all duration-1000 ${isHost ? (isSpeaking ? 'border-orange-500/60 shadow-[0_0_70px_rgba(249,115,22,0.15)]' : 'border-orange-900/20') : (status === ConnectionStatus.CONNECTED ? 'border-blue-500/40 shadow-[0_0_70px_rgba(37,99,235,0.15)]' : 'border-blue-900/20')}`}>
          
          <div className="absolute top-0 left-0 right-0 p-6 flex justify-between items-center z-20 bg-gradient-to-b from-black/95 via-black/40 to-transparent pointer-events-none">
            <div className="flex items-center gap-2">
               <span className={`text-[8px] font-black uppercase tracking-[0.3em] ${isHost ? 'text-orange-500/80' : 'text-blue-500/80'}`}>
                {isHost ? 'BROADCASTING FROM MIC' : 'SYNCED TO CLOUD STREAM'}
              </span>
            </div>
            <div className="flex gap-2">
              {quotaWait > 0 && (
                <div className="flex items-center bg-red-500/20 border border-red-500/40 px-3 py-1 rounded-full animate-pulse">
                  <span className="text-[8px] font-black text-red-500 tracking-widest uppercase">Quota Wait: {Math.round(quotaWait)}s</span>
                </div>
              )}
              {isProcessingTTS && quotaWait === 0 && (
                <div className={`flex items-center px-3 py-1 rounded-full animate-pulse border transition-colors ${isHost ? 'bg-emerald-500/20 border-emerald-500/40' : 'bg-blue-500/20 border-blue-500/40'}`}>
                  <span className={`text-[8px] font-black tracking-widest uppercase ${isHost ? 'text-emerald-500' : 'text-blue-400'}`}>
                    {isHost ? 'HOST TTS ACTIVE' : 'VOICING TRANSLATION'}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-8 space-y-12 pt-28 pb-32 scrollbar-hide transcription-gradient-mask">
            {transcriptions.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center opacity-30">
                <div className="relative">
                   <div className={`w-28 h-28 border-2 rounded-full flex items-center justify-center transition-all duration-1000 ${status === ConnectionStatus.CONNECTED ? (isHost ? 'border-orange-500 scale-110 shadow-[0_0_30px_rgba(249,115,22,0.3)]' : 'border-blue-500 scale-110 shadow-[0_0_30px_rgba(37,99,235,0.3)]') : 'border-zinc-800'}`}>
                      <svg xmlns="http://www.w3.org/2000/svg" className={`h-12 w-12 transition-colors duration-700 ${status === ConnectionStatus.CONNECTED ? (isHost ? 'text-orange-500' : 'text-blue-500') : 'text-zinc-800'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                   </div>
                </div>
                <p className={`mt-10 text-[10px] font-black tracking-[0.5em] uppercase text-center px-12 leading-loose transition-colors duration-500 ${isHost ? 'text-orange-900' : 'text-blue-900'}`}>
                  {isHost ? 'Initialize Host Session to Broadcast' : 'Awaiting Participant Sync Signal'}
                </p>
              </div>
            ) : (
              transcriptions.map((s, idx) => (
                <div key={s.id + idx} className={`animate-segment-pop group`}>
                   <p className={`text-2xl leading-tight tracking-tight transition-all duration-700 ${s.isFinal ? 'text-zinc-100 font-black opacity-100 drop-shadow-[0_2px_10px_rgba(0,0,0,0.8)]' : (isHost ? 'text-orange-500/80' : 'text-blue-400/80') + ' animate-pulse font-medium italic opacity-60'}`}>
                      {s.text.trim()}
                   </p>
                </div>
              ))
            )}
          </div>

          {isHost && (
            <div className="absolute bottom-6 left-6 right-6">
               <div className="rounded-[2.5rem] overflow-hidden border border-orange-900/30 shadow-2xl bg-black/80 backdrop-blur">
                 <Visualizer active={status === ConnectionStatus.CONNECTED} analyser={analyserRef.current || undefined} />
               </div>
            </div>
          )}
        </div>
      </main>

      <footer className="px-10 pb-12 pt-4 z-20">
        {isHost ? (
          status === ConnectionStatus.CONNECTED ? (
            <button onClick={stopBroadcasting} className="group relative w-full h-18 rounded-3xl overflow-hidden active:scale-95 transition-all">
              <div className="absolute inset-0 bg-zinc-900 border-2 border-orange-900/40 group-hover:bg-zinc-800 transition-colors" />
              <span className="relative z-10 text-[11px] font-black uppercase tracking-[0.4em] text-orange-500">Terminate Host Control</span>
            </button>
          ) : (
            <button onClick={startBroadcasting} disabled={status === ConnectionStatus.CONNECTING} className="group relative w-full h-18 rounded-3xl overflow-hidden active:scale-95 transition-all disabled:opacity-50">
              <div className="absolute inset-0 bg-orange-600 group-hover:bg-orange-500 transition-colors shadow-[0_20px_50px_rgba(234,88,12,0.3)]" />
              <span className="relative z-10 flex items-center justify-center gap-4 text-[11px] font-black uppercase tracking-[0.4em] text-white">
                {status === ConnectionStatus.CONNECTING && <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />}
                {status === ConnectionStatus.CONNECTING ? 'Configuring Host...' : 'Launch Session'}
              </span>
            </button>
          )
        ) : (
           <div className={`h-18 flex items-center justify-between bg-zinc-900/90 backdrop-blur-2xl border px-8 rounded-3xl shadow-xl transition-all duration-500 ${status === ConnectionStatus.CONNECTED ? 'border-blue-500/40 shadow-blue-900/20' : 'border-zinc-800'}`}>
              <div className="flex flex-col">
                <span className={`text-[8px] font-black uppercase tracking-widest mb-1 ${status === ConnectionStatus.CONNECTED ? 'text-blue-500' : 'text-zinc-600'}`}>Network Link Status</span>
                <span className={`text-[10px] font-black uppercase tracking-tight ${status === ConnectionStatus.CONNECTED ? 'text-white' : 'text-zinc-700'}`}>
                  {status === ConnectionStatus.CONNECTED ? 'Participant Receiving' : 'Sync Offline'}
                </span>
              </div>
              <div className="flex gap-2 h-5 items-center">
                {[1,2,3,4,5,6,7].map(i => (
                  <div key={i} className={`w-1 rounded-full transition-all duration-500 ${status === ConnectionStatus.CONNECTED ? 'bg-blue-500/60 animate-bounce' : 'bg-zinc-800'}`} 
                       style={{ 
                         animationDelay: `${i * 0.1}s`, 
                         height: status === ConnectionStatus.CONNECTED ? `${30 + (Math.random() * 70)}%` : '15%',
                         animationDuration: '0.8s' 
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
