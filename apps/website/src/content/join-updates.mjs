import { load } from 'cheerio';

// Explicit content changes requested after the verbatim source capture.
// Keep source-site/ and site.json intact so unrelated copy remains auditable.
export function applyJoinUpdates(html) {
  const $ = load(html, null, false);
  const signup = $('a').filter((_, el) => $(el).text().trim() === 'Fill out the form!').first();
  if (!signup.length) throw new Error('Cannot locate the original signup button.');
  const signupWrapper = signup.parent();
  signup.parent().after('<div class="join-discord-cta"><a class="join-discord-button" href="https://discord.com/invite/nV6faA6cbR" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5151c-.2109.3753-.4574.8801-.6273 1.2816a18.2709 18.2709 0 0 0-5.4165 0c-.1708-.4015-.4228-.9063-.6356-1.2816A19.736 19.736 0 0 0 3.8649 4.3698C.7737 8.9877-.0643 13.4907.3547 17.9294a19.9 19.9 0 0 0 5.9956 3.0303c.4827-.6617.9131-1.365 1.2835-2.1034a12.9 12.9 0 0 1-2.0178-.9634c.1692-.1225.3346-.2503.4942-.3819 3.8909 1.8104 8.1189 1.8104 11.9658 0 .1615.1316.3269.2594.4942.3819-.6407.3772-1.3179.6991-2.0207.9644a14.3 14.3 0 0 0 1.2834 2.1024 19.839 19.839 0 0 0 6.0014-3.0303c.4919-5.1458-.8409-9.6074-3.5165-13.5596ZM8.02 15.3312c-1.168 0-2.125-1.0624-2.125-2.3665 0-1.3041.9365-2.3684 2.125-2.3684 1.1886 0 2.1455 1.0735 2.125 2.3684 0 1.3041-.9365 2.3665-2.125 2.3665Zm7.86 0c-1.168 0-2.125-1.0624-2.125-2.3665 0-1.3041.9365-2.3684 2.125-2.3684 1.1886 0 2.1455 1.0735 2.125 2.3684 0 1.3041-.9365 2.3665-2.125 2.3665Z" /></svg><span>Join the Discord server</span></a></div>');
  const paragraph = text => $('.paragraph').filter((_, el) => $(el).text().includes(text)).first();
  const interested = paragraph('We provide all members with an instrument or flag plus music instruction, free!');
  if (!interested.length) throw new Error('Cannot locate the original Interested paragraph.');
  interested.html(interested.html().replace('fill out the form below!', 'fill out the Google form!'));
  interested.append('<br>Rehearsals are drop-in, so you can come try!');

  const interestForm = interested.closest('form');
  const interestHeading = interestForm.find('h2').filter((_, el) => $(el).text().trim() === 'Interested?').first();
  if (!interestForm.length || !interestHeading.length) throw new Error('Cannot locate the original interest form.');
  const formWrapper = interestForm.parent();
  interestHeading.remove();
  interested.remove();
  const actionRow = $('<div class="join-action-row"></div>');
  $('.join-discord-cta').first().before(actionRow);
  actionRow.append(signup.remove());
  actionRow.append($('.join-discord-button').first().remove());
  signupWrapper.remove();
  $('.join-discord-cta').remove();
  signup.removeClass('wsite-button wsite-button-small wsite-button-normal').addClass('join-google-form-button');
  signup.find('.wsite-button-inner').removeClass('wsite-button-inner');
  // Replace the whole old wrapper so its reCAPTCHA sibling and hidden fields
  // disappear with the form; move the original Google link rather than copy it.
  formWrapper.empty().addClass('join-interest').append(interestHeading, interested);
  interested.closest('.wsite-multicol').addClass('join-main-columns');

  const location = paragraph('We rehearse Tuesdays 7:30-10:00 PM in');
  if (!location.length) throw new Error('Cannot locate the original rehearsal information.');
  location.html(location.html().replace('Fitzhenry Studio, David Braley Athletic Centre (DBAC)', '<strong class="join-rehearsal-venue">Fitzhenry Studio @ David Braley Athletic Centre (DBAC)</strong>'));
  location.append('<br>New members attending their first rehearsal should arrive 30 minutes early to grab an instrument and get set up.');

  const overview = paragraph('MMB has a hornline, drumline and colour guard!');
  overview.html(overview.html().replace('MMB has a hornline, drumline and colour guard!', 'MMB has a hornline (brass, woodwinds), drumline and colour guard!'));

  const hornline = paragraph("MMB's hornline consists of a wide variety of instruments");
  if (!hornline.length) throw new Error('Cannot locate the original hornline description.');
  hornline.html('<span style="color:rgb(42, 42, 42)">MMB\'s brass section consists of brass instruments including trumpets, trombones, sousaphones and more. They provide the sing-along melody and the thumping bass lines to all our tunes.</span>');

  const drumline = paragraph('The drumline is the heartbeat of MMB.');
  const colourGuard = paragraph('The colour guard leads the band, spinning flags');
  const headings = ['Hornline', 'Drumline', 'Colour Guard'].map(title => $('h2').filter((_, el) => $(el).text().trim() === title).first());
  const photos = headings.map(heading => heading.next('div').find('img').first().clone());
  if (!drumline.length || !colourGuard.length || photos.some(photo => !photo.length)) throw new Error('Cannot locate the original ensemble sections.');

  const cards = [
    { title: 'Brass', photo: photos[0].clone().attr('src', '/original/dfb518a51979ba0fbe3b.jpg').attr('alt', 'McMaster Marching Band sousaphone and trombone players'), content: hornline.html() },
    { title: 'Woodwinds', photo: photos[0], content: '<span style="color:rgb(42, 42, 42)">MMB\'s woodwinds consist of woodwind instruments including flutes, clarinets, saxophones and more.</span>' },
    { title: 'Drumline', photo: photos[1], content: drumline.html() },
    { title: 'Colour Guard', photo: photos[2], content: colourGuard.html() },
  ];
  // Replace the old split tables and standalone guard block together, keeping
  // the introduction, every original image, and all approved section copy.
  const ensemble = overview.parent().addClass('join-ensemble');
  overview.nextAll().remove();
  const grid = $('<div class="join-ensemble-grid"></div>');
  for (const card of cards) {
    const id = `ensemble-${card.title.toLowerCase().replaceAll(' ', '-')}`;
    const section = $('<section class="join-ensemble-card"></section>').attr('aria-labelledby', id);
    section.append($('<h2 class="wsite-content-title"></h2>').attr('id', id).text(card.title));
    section.append($('<figure class="join-ensemble-card-photo"></figure>').append(card.photo.clone().removeAttr('style')));
    section.append($('<div class="paragraph"></div>').html(card.content));
    grid.append(section);
  }
  ensemble.append(grid);
  return $.html();
}
