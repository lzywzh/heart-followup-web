export interface BriefSummary { title: string; items: { label: string; value: string }[]; note: string }
export interface Turn { id?: string; clientMessageId: string; status: string; patientText?: string; assistantText?: string; superseded?: boolean }
export interface Session { id: string; version: number; status: string; greeting?: string; turns: Turn[]; briefSummary?: BriefSummary; feedback?: string | null; requiresHumanReview?:boolean; audioOperations?: {clientMessageId:string;status:string}[] }
export interface Capabilities { asr: boolean; tts: boolean|null; ready: boolean; ttsMode: 'browser' | 'cloud' | 'server'; message: string }
export interface Patient { id: string; name: string; birthDate: string; sex: string; phone: string; emergencyContact: string; emergencyPhone: string; personalNotes: string; medicalRecord: Record<string,string> }
export interface Workspace { patient: Patient | null; tasks: {id:string;title:string;status:string;scheduled_at:string;available:boolean;overdue:boolean}[]; history: {id:string;started_at:string;status:string;briefSummary?:BriefSummary;feedback?:string}[]; activeSession: {id:string;status:string} | null }
