import { InlineKeyboard } from 'grammy';

export const MENU_TITLE = 'Chọn tác vụ:';

// Menu chính: đúng 3 nút, mỗi nút 1 hàng.
export function mainKeyboard() {
  return new InlineKeyboard()
    .text('Tắt máy sau 30s', 'go:pc:now')
    .row()
    .text('Chụp màn hình PC', 'go:pc:shot')
    .row()
    .text('Link Web (WiFi)', 'go:web:link');
}

export async function sendMainMenu(ctx) {
  await ctx.reply(MENU_TITLE, { reply_markup: mainKeyboard() });
}
