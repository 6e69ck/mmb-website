import { load } from 'cheerio';

// Keep the captured profiles intact; only group them and add unfilled roles.
export function applyTeamUpdates(html) {
  const $ = load(html, null, false);
  const content = $('.wsite-section-elements').first();
  if (!content.length) throw new Error('Cannot locate the original team profiles.');

  const memberSection = $('h2').filter((_, el) => $(el).text().startsWith('Samara Rahman')).first().closest('.wsite-section-wrap');
  const secondMemberRow = $('h2').filter((_, el) => $(el).text().startsWith('Oie Mok')).first().closest('.wsite-section-wrap');
  if (!memberSection.length || !secondMemberRow.length) throw new Error('Cannot locate the original executive member rows.');
  memberSection.addClass('team-executive-members');
  memberSection.find('.wsite-section-elements').first().append(secondMemberRow.find('.wsite-section-elements').first().contents());
  secondMemberRow.remove();

  content.prepend('<h2 id="team-executives-heading" class="wsite-content-title team-group-heading">Executives</h2>');
  const executives = $('<section class="team-executives" aria-labelledby="team-executives-heading"></section>');
  executives.append($.root().contents());
  $.root().append(executives);

  const leaders = $('<section class="team-leaders wsite-section-wrap" aria-labelledby="team-leaders-heading"></section>');
  const section = $('<div class="wsite-section wsite-body-section"></div>');
  const container = $('<div class="wsite-section-content"><div class="container"><div class="wsite-section-elements"></div></div></div>');
  const elements = container.find('.wsite-section-elements');
  elements.append('<h2 id="team-leaders-heading" class="wsite-content-title team-group-heading">Section Leaders</h2>');
  const grid = $('<div class="team-leader-grid"></div>');
  const sectionLeaders = [
    { role: 'Brass lead', name: 'Samuel Zhao' },
    { role: 'Winds lead', name: 'Cole' },
    { role: 'Drumline lead', name: 'Liam Henderson' },
    { role: 'Guard lead', name: '' },
  ];
  for (let index = 0; index < sectionLeaders.length; index += 2) {
    const row = $('<div class="wsite-multicol team-leader-row"><div class="wsite-multicol-table-wrap" style="margin:0 -15px;"><table class="wsite-multicol-table"><tbody class="wsite-multicol-tbody"><tr class="wsite-multicol-tr"></tr></tbody></table></div></div>');
    for (const { role, name } of sectionLeaders.slice(index, index + 2)) {
      const id = `team-${role.toLowerCase().replaceAll(' ', '-')}`;
      const profile = $('<td class="wsite-multicol-col team-leader-profile" style="width:50%; padding:0 15px;"></td>').attr('aria-labelledby', id);
      profile.append('<div class="wsite-spacer" style="height:10px;"></div>');
      profile.append('<div><div class="wsite-image wsite-image-border-none" style="padding-top:10px;padding-bottom:10px;margin-left:0;margin-right:0;text-align:center;"><div class="team-placeholder-portrait" aria-hidden="true"><span class="team-placeholder-head"></span><span class="team-placeholder-body"></span></div></div></div>');
      profile.append('<div class="wsite-spacer" style="height:10px;"></div>');
      profile.append($('<h2 class="wsite-content-title" style="text-align:left;"></h2>').attr('id', id).text(name || role));
      const metadata = $('<div class="paragraph team-placeholder-status" style="text-align:left;"><em><font color="#a1a1a1" size="3"></font></em></div>');
      metadata.find('font').text(name ? role : 'To be announced');
      profile.append(metadata);
      row.find('.wsite-multicol-tr').append(profile);
    }
    grid.append(row);
  }
  elements.append(grid);
  section.append(container);
  leaders.append(section);
  $.root().append(leaders);
  return $.html();
}
