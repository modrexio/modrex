use super::*;

const FIXTURE: &str = include_str!("fixtures/news_payday3.html");

#[test]
fn parses_articles_from_category_page() {
    let items = parse_news_html(FIXTURE);
    assert_eq!(items.len(), 2);

    let first = &items[0];
    assert_eq!(first.title, "PAYDAY 3: Update 3.5.1 Changelog");
    assert_eq!(
        first.url,
        "https://www.paydaythegame.com/news/payday3/2026/05/update-3-5-1/"
    );
    assert_eq!(first.date, "May 22, 2026");
    assert!(first
        .excerpt
        .starts_with("We are now rolling out a new Hotfix"));
    assert_eq!(
        first.image,
        Some(
            "https://www.paydaythegame.com/ovk-media/2024/01/ce5d314722538299cf263548b8e3b8165ec9144e-700x394.png"
                .to_string()
        )
    );
    assert_eq!(first.categories, vec!["PAYDAY 3".to_string()]);
}

#[test]
fn category_slug_comes_from_the_package_news_binding() {
    assert_eq!(category_slug("pd2"), Some("payday2"));
    assert_eq!(category_slug("pdth"), Some("theheist"));
    assert_eq!(category_slug("pd3"), Some("payday3"));
    assert_eq!(category_slug("unknown"), None);
    // A game that declares no news binding must not fall back to another game's category.
    assert_eq!(category_slug("cb"), None);
    assert_eq!(category_slug("raid"), None);
}

#[test]
fn category_url_omits_page_segment_on_first_page() {
    assert_eq!(
        category_url("pd3", 1).as_deref(),
        Some("https://www.paydaythegame.com/news/category/payday3/")
    );
    assert_eq!(
        category_url("pd3", 0).as_deref(),
        Some("https://www.paydaythegame.com/news/category/payday3/")
    );
}

#[test]
fn category_url_adds_page_segment_for_later_pages() {
    assert_eq!(
        category_url("pd2", 3).as_deref(),
        Some("https://www.paydaythegame.com/news/category/payday2/page/3/")
    );
}

#[test]
fn extract_total_pages_reads_last_link_on_early_pages() {
    let html = r#"<div class=wp-pagenavi role=navigation>
        <span aria-current=page class=current>1</span>
        <a class="page larger" href=https://www.paydaythegame.com/news/category/payday3/page/2/>2</a>
        <a class=last href=https://www.paydaythegame.com/news/category/payday3/page/19/>Last »</a>
    </div>"#;
    assert_eq!(extract_total_pages(html), 19);
}

#[test]
fn extract_total_pages_falls_back_to_current_span_on_last_page() {
    // WP-PageNavi shows no .last link when you are already on the last page.
    let html = r#"<div class=wp-pagenavi role=navigation>
        <a class=first href=https://www.paydaythegame.com/news/category/payday3/>« First</a>
        <a class="page smaller" href=https://www.paydaythegame.com/news/category/payday3/page/18/>18</a>
        <span aria-current=page class=current>19</span>
    </div>"#;
    assert_eq!(extract_total_pages(html), 19);
}

#[test]
fn extract_total_pages_defaults_to_one_without_pagenavi() {
    assert_eq!(
        extract_total_pages("<html><body>no pagination here</body></html>"),
        1
    );
}
