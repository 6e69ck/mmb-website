import { useEffect } from 'react';

type Captcha = { render: (el: HTMLElement, options: Record<string, unknown>) => number; execute: (id: number) => void; reset: (id: number) => void; ready: (fn: () => void) => void };
declare global { interface Window { grecaptcha?: Captcha } }

export default function FormExperience() {
  useEffect(() => {
    const forms = [...document.querySelectorAll<HTMLFormElement>('#wsite-content form')];
    if (!forms.length) return;
    let active = true;
    const controllers = new Map<HTMLFormElement, number>();
    const pending = new Set<HTMLFormElement>();
    const captchaFor = (form: HTMLFormElement) => document.getElementById(`g-recaptcha-${form.id.replace('form-', '')}`);
    const prepare = () => window.grecaptcha?.ready(() => {
      if (!active) return;
      for (const form of forms) {
        const element = captchaFor(form);
        if (!element || controllers.has(form)) continue;
        const id = window.grecaptcha!.render(element, {
          sitekey: element.dataset.sitekey,
          size: 'invisible',
          callback: (token: string) => {
            const field = form.querySelector<HTMLInputElement>('[name="recaptcha_token"]');
            if (field) field.value = token;
            HTMLFormElement.prototype.submit.call(form);
          },
          'expired-callback': () => { pending.delete(form); window.grecaptcha?.reset(id); },
          'error-callback': () => { pending.delete(form); window.grecaptcha?.reset(id); },
        });
        controllers.set(form, id);
        if (pending.has(form)) window.grecaptcha!.execute(id);
      }
    });
    let script: HTMLScriptElement | null = null;
    const submit = (event: SubmitEvent) => {
      const form = event.currentTarget as HTMLFormElement;
      if (!captchaFor(form)) return;
      event.preventDefault();
      if (pending.has(form)) return;
      pending.add(form);
      const id = controllers.get(form);
      if (id !== undefined) window.grecaptcha?.execute(id);
      else if (window.grecaptcha?.render) prepare();
      else if (!script) {
        script = document.createElement('script');
        script.src = 'https://www.google.com/recaptcha/api.js?render=explicit';
        script.async = true; script.defer = true;
        script.addEventListener('load', prepare);
        script.addEventListener('error', () => pending.delete(form));
        document.head.append(script);
      }
    };
    forms.forEach(form => form.addEventListener('submit', submit));
    return () => { active = false; forms.forEach(form => form.removeEventListener('submit', submit)); script?.removeEventListener('load', prepare); };
  }, []);
  return null;
}
