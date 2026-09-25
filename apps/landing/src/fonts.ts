/**
 * 폰트는 자체 호스팅한다. 랜딩이 외부 폰트 서버에 요청을 보내면 그 서버가
 * 방문 사실을 알게 된다 — 제3자 의존을 금지한 보안 설계와 어긋난다.
 *
 * TODO: 배포 전 실사용 글리프만 서브셋한다. 한글 웨이트 하나가 500KB다.
 */
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/ibm-plex-sans-kr/latin-400.css";
import "@fontsource/ibm-plex-sans-kr/latin-600.css";
import "@fontsource/ibm-plex-sans-kr/korean-400.css";
import "@fontsource/ibm-plex-sans-kr/korean-600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
