import { textLinks } from './lib/textLinks';

export default function TextWithLinks({ text }: { text: string }) {
  return <>{textLinks(text).map((part, index) => part.href
    ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" data-preserve-case>{part.text}</a>
    : part.text)}</>;
}
