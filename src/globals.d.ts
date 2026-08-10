// ST 在全局挂载的第三方库。jQuery 的全局 `$` 由 @types/jquery 提供,这里补充其余项。

export {};

declare global {
    // jQuery UI sortable（ST 通过 /lib/jquery-ui.min.js 全局挂载，profile-editor 拖拽排序用）
    interface JQuery<TElement = HTMLElement> {
        sortable(options?: Record<string, any>): this;
        sortable(command: string): this;
    }
}
