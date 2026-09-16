const previewWebview = {
    onDragDropEvent(): Promise<() => void> {
        return Promise.resolve(() => {})
    },
}

export function getCurrentWebview() {
    return previewWebview
}
