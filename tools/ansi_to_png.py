from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import re, sys

ESC='\x1b['
SGR_RE=re.compile(r'\x1b\[([0-9;]*)m')
CURSOR_RE=re.compile(r'\x1b\[(\d+);(\d+)H')
CLEAR_RE=re.compile(r'\x1b\[2J|\x1b\[K')
HIDE_RE=re.compile(r'\x1b\[\?[0-9;]*[hl]')
ERASE_RE=re.compile(r'\x1b\[2K')

ANSI16={
 30:(0,0,0),31:(180,55,70),32:(75,190,90),33:(215,175,55),34:(65,115,200),35:(180,100,195),36:(65,180,200),37:(235,235,235),
 90:(100,100,100),91:(240,90,100),92:(100,235,115),93:(255,220,95),94:(100,150,240),95:(225,130,235),96:(100,225,235),97:(255,255,255)}

def ansi256(n):
    if 16 <= n <= 231:
        n -= 16; b=n%6; g=(n//6)%6; r=(n//36)%6; c=[0,95,135,175,215,255]
        return c[r],c[g],c[b]
    if 232 <= n <= 255:
        v=8+(n-232)*10; return v,v,v
    return (0,0,0)

def parse(path, width, height):
    text=Path(path).read_text(errors='replace')
    grid=[[{'ch':' ','fg':(225,225,225),'bg':None,'bold':False} for _ in range(width)] for _ in range(height)]
    row=0; col=0; fg=(225,225,225); bg=None; bold=False
    i=0
    while i < len(text):
        if text.startswith('\x1b[',i):
            m=SGR_RE.match(text,i)
            if m:
                parts=[int(x) if x else 0 for x in m.group(1).split(';')] if m.group(1) else [0]
                j=0
                while j<len(parts):
                    code=parts[j]
                    if code==0: fg=(225,225,225); bg=None; bold=False
                    elif code==1: bold=True
                    elif 30<=code<=37 or 90<=code<=97: fg=ANSI16[code]
                    elif code==39: fg=(225,225,225)
                    elif code==49: bg=None
                    elif code==38 and j+2<len(parts) and parts[j+1]==5: fg=ansi256(parts[j+2]); j+=2
                    elif code==48 and j+2<len(parts) and parts[j+1]==5: bg=ansi256(parts[j+2]); j+=2
                    j+=1
                i=m.end(); continue
            m=CURSOR_RE.match(text,i)
            if m:
                row=max(0,min(height-1,int(m.group(1))-1)); col=max(0,min(width,int(m.group(2))-1)); i=m.end(); continue
            if text.startswith('\x1b[2J',i):
                for rr in range(height):
                    for cc in range(width): grid[rr][cc]={'ch':' ','fg':fg,'bg':bg,'bold':bold}
                row=0;col=0;i+=4;continue
            if text.startswith('\x1b[2K',i):
                for cc in range(width): grid[row][cc]={'ch':' ','fg':fg,'bg':bg,'bold':bold}
                i+=4;continue
            if text.startswith('\x1b[?25l',i): i+=6; continue
            # unknown CSI: consume until final byte
            j=i+2
            while j<len(text) and not (0x40<=ord(text[j])<=0x7e): j+=1
            i=min(len(text),j+1); continue
        ch=text[i]
        if ch=='\n': row=min(height-1,row+1); col=0
        elif ch=='\r': col=0
        elif ch=='\t': col=min(width,col+4-(col%4))
        elif ord(ch)>=32:
            if 0<=row<height and 0<=col<width: grid[row][col]={'ch':ch,'fg':fg,'bg':bg,'bold':bold}
            col+=1
            if col>=width: col=width-1
        i+=1
    return grid

def render(grid,out,width,height,title):
    font_path='/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
    font_bold='/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
    font=ImageFont.truetype(font_path,16); fontb=ImageFont.truetype(font_bold,16)
    char_w=10; char_h=20; pad=18; title_h=30
    img=Image.new('RGB',(width*char_w+pad*2,height*char_h+pad*2+title_h),(31,34,42))
    d=ImageDraw.Draw(img)
    d.text((pad,8),title,fill=(180,185,200),font=fontb)
    y0=title_h+pad
    for r,row in enumerate(grid):
        for c,cell in enumerate(row):
            x=pad+c*char_w; y=y0+r*char_h
            if cell['bg']:
                d.rectangle((x,y,x+char_w,y+char_h),fill=cell['bg'])
            ch=cell['ch']
            if ch!=' ':
                d.text((x,y-2),ch,fill=cell['fg'],font=fontb if cell['bold'] else font)
    img.save(out)

if __name__=='__main__':
    raw=sys.argv[1]; out=sys.argv[2]; w=int(sys.argv[3]); h=int(sys.argv[4]); title=sys.argv[5]
    render(parse(raw,w,h),out,w,h,title)
