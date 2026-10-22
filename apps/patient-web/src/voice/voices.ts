export function chineseVoice(voices:SpeechSynthesisVoice[]):SpeechSynthesisVoice|undefined {
  const score=(voice:SpeechSynthesisVoice)=>/natural|neural|自然/i.test(voice.name)?4:/xiaoxiao|xiaoyi|yunxi|晓晓/i.test(voice.name)?3:/tingting|xiaomei|huihui/i.test(voice.name)?2:1;
  return voices.filter(v=>/^zh(?:[-_](?:CN|Hans)(?:[-_].*)?)?$/i.test(v.lang)).sort((a,b)=>score(b)-score(a))[0];
}
