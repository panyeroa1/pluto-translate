
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../constants';
import { TranscriptionSegment } from '../types';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Broadcasts a transcription segment to a specific class channel.
 * Uses the requested 'transcription_text' event name.
 */
export const broadcastTranscription = async (classId: string, segment: TranscriptionSegment) => {
  const channel = supabase.channel(`class_${classId}`);
  
  // We don't wait for subscription here to avoid latency, 
  // but ensure it's established for the session.
  await channel.send({
    type: 'broadcast',
    event: 'transcription_text',
    payload: segment,
  });
};

/**
 * Subscribes to transcription segments for a specific class.
 */
export const subscribeToTranscription = (classId: string, onMessage: (segment: TranscriptionSegment) => void) => {
  const channel = supabase.channel(`class_${classId}`);
  
  channel
    .on('broadcast', { event: 'transcription_text' }, ({ payload }) => {
      onMessage(payload as TranscriptionSegment);
    })
    .subscribe((status) => {
      console.log(`Supabase connection status for ${classId}:`, status);
    });

  return () => {
    supabase.removeChannel(channel);
  };
};
