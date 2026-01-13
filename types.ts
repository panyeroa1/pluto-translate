
export type AppMode = 'SOURCE' | 'RECEIVER';

export interface TranscriptionSegment {
  id: string;
  text: string;
  timestamp: number;
  speaker: 'user' | 'model';
  isFinal: boolean;
  classId: string;
}

export interface AudioVisualizerData {
  frequencyData: Uint8Array;
}

export enum ConnectionStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}
