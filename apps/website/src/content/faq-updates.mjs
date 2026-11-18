import { load } from 'cheerio';

// Only the two audience navigation labels and their presentation change.
// Questions, answers, section headings, and original anchor destinations stay intact.
export function applyFaqUpdates(html) {
  const $ = load(html, null, false);
  const students = $('a[href$="/faq.html#students"]').filter((_, el) => $(el).text().trim() === 'FAQ for students');
  const organizers = $('a[href$="/faq.html#organizers"]').filter((_, el) => $(el).text().trim() === 'FAQ for event organizers');
  if (students.length !== 1 || organizers.length !== 1) throw new Error('Cannot locate the original FAQ audience links.');
  const container = students.parent('.paragraph');
  if (!container.length || organizers.parent()[0] !== container[0]) throw new Error('FAQ audience links are no longer grouped together.');

  students.text('Students').addClass('faq-audience-button');
  organizers.text('Organizers').addClass('faq-audience-button');
  students.attr('href', '#students');
  organizers.attr('href', '#organizers');
  students.attr('data-faq-target', 'students');
  organizers.attr('data-faq-target', 'organizers');
  const navigation = $('<nav class="faq-audience-navigation" aria-label="FAQ audiences"></nav>');
  navigation.append(students).append(organizers);
  container.replaceWith(navigation);
  $('body').append(`<script>
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-faq-target]');
      if (!button) return;
      const target = document.getElementById(button.dataset.faqTarget);
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
      history.replaceState(null, '', button.getAttribute('href'));
    });
  </script>`);
  return $.html();
}
